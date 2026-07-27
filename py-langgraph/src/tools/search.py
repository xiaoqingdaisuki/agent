"""
web.search — 多来源互联网搜索，返回结构化结果

特性:
- 多来源降级: Bing → Searx → DuckDuckGo
- 结构化返回: title, url, snippet, provider, rank
- 结果去重: 基于 URL
- 超时控制: 各源独立超时
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import re
from dataclasses import dataclass, field
from typing import Any

import httpx
from html import unescape

from langchain_core.tools import tool
from pydantic import BaseModel, Field

from src.tools.contracts import (
    ToolCategory,
    ToolDescriptor,
    ToolResultEnvelope,
    ToolResultMeta,
    SideEffect,
)


# ============ 搜索结果模型 ============


@dataclass
class SearchResultItem:
    """单个搜索结果"""
    title: str
    url: str
    snippet: str
    provider: str
    rank: int = 0
    published_at: str = ""
    retrieved_at: str = field(default_factory=lambda: __import__("datetime").datetime.now().isoformat())


def search_results_to_text(results: list[SearchResultItem], query: str) -> str:
    """将结构化结果转换为展示文本"""
    if not results:
        return f'联网搜索未返回结果。你可以基于你的知识直接回答用户关于"{query}"的问题，同时说明这是基于训练数据而非实时搜索。'

    lines = [f"🔍 搜索结果（{query}） — 共 {len(results)} 条：\n"]
    for i, r in enumerate(results, 1):
        lines.append(f"[{i}] {r.title}")
        lines.append(f"    {r.url}")
        lines.append(f"    {r.snippet[:150]}")
        if r.published_at:
            lines.append(f"    发布时间：{r.published_at}")
        lines.append("")

    return "\n".join(lines)


# ============ 搜索实现 ============

def _clean_html(text: str) -> str:
    text = unescape(text)
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def _search_bing(query: str) -> list[SearchResultItem] | None:
    """Bing HTML 搜索"""
    try:
        with httpx.Client(timeout=6, follow_redirects=True) as client:
            res = client.get(
                "https://www.bing.com/search",
                params={"q": query, "setmkt": "zh-CN"},
                headers={
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
                },
            )
            if not res.is_success:
                return None

        html = res.text
        results: list[SearchResultItem] = []
        seen = set()

        for match in re.finditer(r'<li class="b_algo"[^>]*>(.*?)</li>', html, re.DOTALL):
            item = match.group(1)

            # 允许 <h2> 带额外属性（class 等）
            title_match = re.search(r'<h2[^>]*><a[^>]*href="([^"]+)"[^>]*>(.*?)</a></h2>', item, re.DOTALL)
            if not title_match:
                continue

            url = title_match.group(1)
            title = _clean_html(title_match.group(2))
            if not title or url in seen:
                continue
            seen.add(url)

            # 优先使用 b_lineclamp 类摘要，回退到第一个 <p>
            snippet = "无摘要"
            lineclamp_match = re.search(r'<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>(.*?)</p>', item, re.DOTALL)
            if lineclamp_match:
                snippet = _clean_html(lineclamp_match.group(1))[:300]
            else:
                snippet_match = re.search(r"<p[^>]*>(.*?)</p>", item, re.DOTALL)
                snippet = _clean_html(snippet_match.group(1))[:300] if snippet_match else snippet

            results.append(SearchResultItem(
                title=title,
                url=url,
                snippet=snippet[:300],
                provider="bing",
                rank=len(results) + 1,
            ))

            if len(results) >= 5:
                break

        return results if results else None

    except Exception:
        return None


def _search_searx(query: str) -> list[SearchResultItem] | None:
    """Searx 实例搜索"""
    instances = [
        "https://search.sapti.me",
        "https://searx.be",
        "https://search.bus-hit.me",
    ]

    for instance in instances:
        try:
            with httpx.Client(timeout=3.5, follow_redirects=True) as client:
                res = client.get(
                    f"{instance}/search",
                    params={"q": query, "format": "json", "engines": "google,bing,duckduckgo", "pageno": "1"},
                    headers={"Accept": "application/json", "User-Agent": "curl/7.68"},
                )
                if not res.is_success:
                    continue
                data = res.json()

                if data.get("results"):
                    return [
                        SearchResultItem(
                            title=r.get("title", ""),
                            url=r.get("url", ""),
                            snippet=(r.get("content") or "")[:300],
                            provider="searx",
                            rank=i + 1,
                            published_at=r.get("publishedDate", ""),
                        )
                        for i, r in enumerate(data["results"][:5])
                    ]
        except Exception:
            continue

    return None


def _search_duckduckgo(query: str) -> list[SearchResultItem] | None:
    """DuckDuckGo API 搜索"""
    try:
        with httpx.Client(timeout=5, follow_redirects=True) as client:
            res = client.get(
                "https://api.duckduckgo.com/",
                params={"q": query, "format": "json", "no_html": 1, "skip_disambig": 1},
            )
            if not res.is_success:
                return None

        data = res.json()
        results: list[SearchResultItem] = []

        if data.get("Abstract"):
            results.append(SearchResultItem(
                title="摘要",
                url=data.get("AbstractURL", ""),
                snippet=data["Abstract"][:300],
                provider="duckduckgo",
                rank=1,
            ))

        if data.get("RelatedTopics"):
            for i, topic in enumerate(data["RelatedTopics"][:5], 1):
                if topic.get("Text") and "search for" not in topic["Text"].lower():
                    results.append(SearchResultItem(
                        title=topic["Text"][:100],
                        url=topic.get("FirstURL", ""),
                        snippet=topic.get("Text", "")[:300],
                        provider="duckduckgo",
                        rank=i + 1,
                    ))

        return results if results else None

    except Exception:
        return None


def multi_source_search(query: str) -> list[SearchResultItem]:
    """多来源搜索，按优先级尝试各源，去重后合并"""
    all_results: list[SearchResultItem] = []
    seen_urls: set[str] = set()

    sources = [
        ("bing", _search_bing),
        ("searx", _search_searx),
        ("duckduckgo", _search_duckduckgo),
    ]

    with ThreadPoolExecutor(max_workers=len(sources)) as executor:
        source_results = list(
            executor.map(lambda source: source[1](query), sources)
        )

    for (provider_name, _), results in zip(sources, source_results):
        if results:
            for result in results:
                if result.url and result.url not in seen_urls:
                    seen_urls.add(result.url)
                    result.provider = provider_name
                    all_results.append(result)

    # 重新编号 rank
    for i, r in enumerate(all_results):
        r.rank = i + 1

    return all_results


# ============ Tool Descriptor ============

_DESCRIPTOR = ToolDescriptor(
    name="web.search",
    version="1.0.0",
    title="互联网搜索",
    description="在互联网上搜索最新信息。当用户问及可能需要事实核查的内容时使用：历史事件、时事新闻、政策法规、具体数据、人物动态、公司信息、体育赛事、学术研究、百科知识等。如果搜索结果不理想，可以基于你的知识直接回答。",
    category="SEARCH",
    risk_level="R1",
    side_effect="read",
    timeout_ms=12000,
    required_permissions=["web.search"],
    data_classification=["internal"],
    owner="tools",
    tags=["web", "search", "internet"],
)


# ============ LangChain Tool ============

class SearchInput(BaseModel):
    query: str = Field(description="搜索关键词，尽量简洁明确，如'深圳8月28日活动'")


@tool(args_schema=SearchInput)
def web_search(query: str) -> str:
    """在互联网上搜索最新信息并返回结果。如果搜索结果不理想，可以基于已有知识回答。"""
    results = multi_source_search(query)
    return search_results_to_text(results, query)
