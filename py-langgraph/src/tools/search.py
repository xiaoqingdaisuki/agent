"""
web.search — Tavily-backed real-time search with retry, circuit breaking and cache fallback.

Core capabilities:
1. Multi-level cache (fresh cache + stale fallback) avoids duplicate requests
2. In-flight dedup prevents the same query from being sent concurrently
3. Circuit breaker auto-degrades after consecutive failures, protecting upstream
4. Auto-retry with backoff for robustness under network flakiness
5. Returns structured results (title, URL, snippet, published_at) for Agent consumption

Design notes:
- Functional layering: settings / private helpers / public API
- Cache key uses lowercased normalized query for consistent hits
- Stale cache returns degraded results instead of hard failure when upstream is down
- reset_search_state_for_tests exposes internal state for unit test isolation
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from html import unescape
import json
import os
import re
from threading import Event, Lock
import time
from urllib.parse import urlparse, urlunparse

import httpx
from langchain_core.tools import tool
from pydantic import BaseModel, Field

from src.config.settings import settings as app_settings
from src.tools.contracts import ToolDescriptor


@dataclass
class SearchResultItem:
    title: str
    url: str
    snippet: str
    provider: str = "tavily"
    rank: int = 0
    published_at: str = ""
    retrieved_at: str = field(default_factory=lambda: datetime.now(UTC).isoformat())


@dataclass
class SearchOutcome:
    results: list[SearchResultItem]
    providers: list[str]
    failed_providers: list[str]
    cached: bool = False
    stale: bool = False


@dataclass(frozen=True)
class SearchSettings:
    api_key: str
    timeout_seconds: float
    max_results: int
    cache_ttl_seconds: int
    stale_ttl_seconds: int
    search_depth: str
    max_attempts: int


@dataclass
class CacheEntry:
    outcome: SearchOutcome
    fresh_until: float
    stale_until: float


@dataclass
class CircuitState:
    failures: int = 0
    open_until: float = 0


@dataclass
class InFlightSearch:
    event: Event = field(default_factory=Event)
    result: SearchOutcome | None = None


_cache: dict[str, CacheEntry] = {}
_in_flight: dict[str, InFlightSearch] = {}
_circuit = CircuitState()
_state_lock = Lock()
_CIRCUIT_FAILURE_THRESHOLD = 3
_CIRCUIT_COOLDOWN_SECONDS = 30
_RETRYABLE_STATUSES = {408, 425, 429, 500, 502, 503, 504}


class _NonRetryableSearchError(RuntimeError):
    pass


# 将字符串安全地限制在整数范围内
def _bounded_integer(raw: str | None, fallback: int, minimum: int, maximum: int) -> int:
    try:
        return min(maximum, max(minimum, int(raw or "")))
    except ValueError:
        return fallback


# 从环境变量和 settings 构建搜索配置
def _get_settings() -> SearchSettings:
    return SearchSettings(
        api_key=os.getenv("TAVILY_API_KEY", "").strip() or app_settings.tavily_api_key,
        timeout_seconds=_bounded_integer(
            os.getenv("SEARCH_TIMEOUT_MS"), app_settings.search_timeout_ms, 1000, 15000
        )
        / 1000,
        max_results=_bounded_integer(
            os.getenv("SEARCH_MAX_RESULTS"), app_settings.search_max_results, 1, 20
        ),
        cache_ttl_seconds=_bounded_integer(
            os.getenv("SEARCH_CACHE_TTL_SECONDS"),
            app_settings.search_cache_ttl_seconds,
            0,
            3600,
        ),
        stale_ttl_seconds=_bounded_integer(
            os.getenv("SEARCH_STALE_TTL_SECONDS"),
            app_settings.search_stale_ttl_seconds,
            0,
            86400,
        ),
        search_depth=(
            "advanced"
            if (os.getenv("TAVILY_SEARCH_DEPTH") or app_settings.tavily_search_depth) == "advanced"
            else "basic"
        ),
        max_attempts=_bounded_integer(
            os.getenv("SEARCH_MAX_ATTEMPTS"), app_settings.search_max_attempts, 1, 2
        ),
    )


# 清洗 HTML 文本，去除标签并解码实体
def _clean_html(text: str) -> str:
    text = re.sub(r"<script[^>]*>[\s\S]*?</script>", "", text, flags=re.IGNORECASE)
    text = re.sub(r"<style[^>]*>[\s\S]*?</style>", "", text, flags=re.IGNORECASE)
    text = unescape(re.sub(r"<[^>]+>", " ", text))
    return re.sub(r"\s+", " ", text).strip()


# 规范化 URL：清理追踪参数，返回 None 表示无效 URL
def _normalize_url(raw_url: str) -> str | None:
    try:
        parsed = urlparse(raw_url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            return None
        query = [
            part
            for part in parsed.query.split("&")
            if part and not re.match(r"^(utm_|fbclid=|gclid=)", part, re.IGNORECASE)
        ]
        return urlunparse(parsed._replace(query="&".join(query), fragment=""))
    except ValueError:
        return None


# 向 Tavily API 发送搜索请求并返回原始响应
def _request_tavily(settings: SearchSettings, query: str) -> httpx.Response:
    last_error: Exception | None = None
    for attempt in range(settings.max_attempts):
        try:
            with httpx.Client(timeout=settings.timeout_seconds, follow_redirects=True) as client:
                response = client.post(
                    "https://api.tavily.com/search",
                    headers={
                        "Accept": "application/json",
                        "Authorization": f"Bearer {settings.api_key}",
                        "Content-Type": "application/json",
                    },
                    json={
                        "query": query,
                        "topic": "general",
                        "search_depth": settings.search_depth,
                        "max_results": settings.max_results,
                        "include_answer": False,
                        "include_raw_content": False,
                    },
                )
            if response.is_success:
                return response
            error = RuntimeError(f"Tavily HTTP {response.status_code}")
            if response.status_code not in _RETRYABLE_STATUSES:
                raise _NonRetryableSearchError(str(error))
            last_error = error
        except _NonRetryableSearchError:
            raise
        except (httpx.HTTPError, RuntimeError) as error:
            last_error = error
        if attempt < settings.max_attempts - 1:
            time.sleep(0.12)
    raise last_error or RuntimeError("Tavily request failed")


# 调用 Tavily 搜索并将结果解析为结构化格式
def _search_tavily(query: str, settings: SearchSettings) -> list[SearchResultItem]:
    data = _request_tavily(settings, query).json()
    results: list[SearchResultItem] = []
    seen: set[str] = set()
    for item in data.get("results", []):
        url = _normalize_url(item.get("url", ""))
        title = _clean_html(item.get("title", ""))
        if not url or not title or url in seen:
            continue
        seen.add(url)
        results.append(
            SearchResultItem(
                title=title,
                url=url,
                snippet=_clean_html(item.get("content", ""))[:500],
                rank=len(results) + 1,
                published_at=item.get("published_date", ""),
            )
        )
    return results


# 执行搜索，处理缓存、熔断和重试逻辑
def _execute_search(
    query: str, cache_key: str, settings: SearchSettings, cached: CacheEntry | None
) -> SearchOutcome:
    now = time.monotonic()
    if not settings.api_key:
        return SearchOutcome([], [], ["tavily:not_configured"])
    with _state_lock:
        circuit_open = _circuit.open_until > now
    if circuit_open:
        if cached and cached.stale_until > now:
            return SearchOutcome(
                cached.outcome.results,
                cached.outcome.providers,
                cached.outcome.failed_providers,
                cached=True,
                stale=True,
            )
        return SearchOutcome([], [], ["tavily:circuit_open"])

    started_at = time.monotonic()
    try:
        results = _search_tavily(query, settings)
        if not results:
            raise RuntimeError("Tavily returned an empty result set")
        outcome = SearchOutcome(results[: settings.max_results], ["tavily"], [])
        with _state_lock:
            _circuit.failures = 0
            _circuit.open_until = 0
            _cache[cache_key] = CacheEntry(
                outcome=outcome,
                fresh_until=now + settings.cache_ttl_seconds,
                stale_until=now + settings.cache_ttl_seconds + settings.stale_ttl_seconds,
            )
        print(
            json.dumps(
                {
                    "event": "web_search_succeeded",
                    "provider": "tavily",
                    "duration_ms": round((time.monotonic() - started_at) * 1000),
                    "result_count": len(outcome.results),
                },
                ensure_ascii=False,
            )
        )
        return outcome
    except Exception as error:
        with _state_lock:
            _circuit.failures += 1
            if _circuit.failures >= _CIRCUIT_FAILURE_THRESHOLD:
                _circuit.open_until = time.monotonic() + _CIRCUIT_COOLDOWN_SECONDS
            failures = _circuit.failures
        print(
            json.dumps(
                {
                    "event": "web_search_failed",
                    "provider": "tavily",
                    "duration_ms": round((time.monotonic() - started_at) * 1000),
                    "reason": str(error),
                    "consecutive_failures": failures,
                },
                ensure_ascii=False,
            )
        )
        if cached and cached.stale_until > now:
            return SearchOutcome(
                cached.outcome.results,
                cached.outcome.providers,
                cached.outcome.failed_providers,
                cached=True,
                stale=True,
            )
        return SearchOutcome([], [], [f"tavily:{error}"])


# 多源搜索入口：处理缓存、去重和并发合并
def multi_source_search(query: str) -> SearchOutcome:
    normalized_query = re.sub(r"\s+", " ", query.strip())
    cache_key = normalized_query.casefold()
    settings = _get_settings()
    now = time.monotonic()
    with _state_lock:
        cached = _cache.get(cache_key)
        if cached and cached.fresh_until > now:
            return SearchOutcome(
                cached.outcome.results,
                cached.outcome.providers,
                cached.outcome.failed_providers,
                cached=True,
            )
        running = _in_flight.get(cache_key)
        if running is None:
            running = InFlightSearch()
            _in_flight[cache_key] = running
            owner = True
        else:
            owner = False

    if not owner:
        running.event.wait(timeout=settings.timeout_seconds * 2 + 1)
        return running.result or SearchOutcome([], [], ["tavily:in_flight_timeout"])

    try:
        result = _execute_search(normalized_query, cache_key, settings, cached)
        running.result = result
        return result
    finally:
        running.event.set()
        with _state_lock:
            _in_flight.pop(cache_key, None)


# 将搜索结果显示格式化为可读文本
def search_results_to_text(outcome: SearchOutcome, query: str) -> str:
    if not outcome.results:
        reason = ", ".join(outcome.failed_providers)
        return (
            f"Tavily 实时搜索暂时不可用（{reason}）。"
            "不要把训练数据描述为实时结果；请告知用户稍后重试。"
        )
    freshness = (
        "⚠️ Tavily 暂时不可用，以下为降级缓存结果" if outcome.stale else "Tavily 实时搜索结果"
    )
    lines = [f"🔍 {freshness}（{query}）— 共 {len(outcome.results)} 条：\n"]
    for index, result in enumerate(outcome.results, 1):
        lines.append(f"[{index}] {result.title}")
        lines.append(f"    {result.url}")
        lines.append(f"    {result.snippet[:300]}")
        if result.published_at:
            lines.append(f"    发布时间：{result.published_at}")
        lines.append("")
    return "\n".join(lines)


# 重置搜索状态（缓存、飞行中请求、熔断器），供测试使用
def reset_search_state_for_tests() -> None:
    with _state_lock:
        _cache.clear()
        _in_flight.clear()
        _circuit.failures = 0
        _circuit.open_until = 0


_DESCRIPTOR = ToolDescriptor(
    name="web.search",
    version="2.0.0",
    title="互联网搜索",
    description="通过 Tavily 搜索实时互联网信息，返回可核查的标题、链接、摘要与发布时间。",
    category="SEARCH",
    risk_level="R1",
    side_effect="read",
    timeout_ms=12000,
    required_permissions=["web.search"],
    data_classification=["internal"],
    owner="tools",
    tags=["web", "search", "internet", "realtime", "tavily"],
)


class SearchInput(BaseModel):
    query: str = Field(min_length=1, max_length=400, description="简洁明确的搜索关键词")


# 使用 Tavily 搜索实时互联网信息并返回来源链接
@tool(args_schema=SearchInput)
# 执行 web search 对应的业务逻辑
def web_search(query: str) -> str:
    """使用 Tavily 搜索实时互联网信息并返回来源链接。"""
    return search_results_to_text(multi_source_search(query), query)
