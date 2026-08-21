"""web.extract — 从网页中提取结构化字段。"""

from __future__ import annotations

import html as html_module
import json
import re

import httpx
from langchain_core.tools import tool
from pydantic import BaseModel, Field

from src.tools.contracts import ToolDescriptor
from src.tools.web_read import _is_safe_url

MAX_RESPONSE_CHARS = 200 * 1024


class WebExtractInput(BaseModel):
    """网页结构化提取工具的输入模型。"""

    url: str = Field(description="要提取数据的网页 URL")
    fields: list[str] = Field(min_length=1, max_length=20, description="需要提取的字段名")


_DESCRIPTOR = ToolDescriptor(
    name="web.extract",
    version="1.0.0",
    title="网页结构化提取",
    description="从指定网页提取结构化字段，例如产品名称、价格和评分。适合批量列表页，不用于文章总结。",
    category="READ",
    risk_level="R1",
    side_effect="read",
    timeout_ms=15000,
    required_permissions=["web.extract"],
    data_classification=["public"],
    owner="tools",
    tags=["web", "extract", "structured"],
)


# 解码网页中常见的 HTML 实体。
def _decode_html(value: str) -> str:
    return html_module.unescape(value)


# 清理 HTML 标签、脚本和样式，保留可匹配的文本。
def _clean_html(value: str) -> str:
    text = re.sub(r"<script[^>]*>[\s\S]*?</script>", " ", value, flags=re.IGNORECASE)
    text = re.sub(r"<style[^>]*>[\s\S]*?</style>", " ", text, flags=re.IGNORECASE)
    text = re.sub(r"<[^>]+>", " ", text)
    return re.sub(r"\s+", " ", _decode_html(text)).strip()


# 生成字段的宽松匹配键，兼容常见产品字段别名。
def _field_keys(field: str) -> list[str]:
    normalized = field.strip().lower().replace("_", " ").replace("-", " ")
    aliases = {
        "name": ["name", "title", "product name"],
        "title": ["title", "name"],
        "price": ["price", "cost", "amount"],
        "rating": ["rating", "score", "stars"],
    }
    return [normalized, *aliases.get(normalized, [])]


# 从一个 HTML 片段中按字段名提取值。
def _extract_field(fragment: str, field: str) -> str:
    keys = [re.escape(key) for key in _field_keys(field)]
    key_pattern = "|".join(keys)
    element_pattern = re.compile(
        rf'<([a-z0-9]+)[^>]*(?:class|id|data-field|itemprop)=["\'][^"\']*(?:{key_pattern})[^"\']*["\'][^>]*>([\s\S]*?)</\1>',
        re.IGNORECASE,
    )
    match = element_pattern.search(fragment)
    if match:
        return _clean_html(match.group(2))[:500]
    label_match = re.search(rf"(?:{key_pattern})\s*[:：]\s*([^|;,]+)", _clean_html(fragment), re.IGNORECASE)
    return label_match.group(1).strip()[:500] if label_match else ""


# 提取 HTML 表格中的数据行。
def _extract_table_items(page: str, fields: list[str]) -> list[dict[str, str]]:
    items: list[dict[str, str]] = []
    for table_match in re.finditer(r"<table[^>]*>([\s\S]*?)</table>", page, re.IGNORECASE):
        rows = []
        for row_match in re.finditer(r"<tr[^>]*>([\s\S]*?)</tr>", table_match.group(1), re.IGNORECASE):
            rows.append([
                _clean_html(cell.group(1))
                for cell in re.finditer(r"<t[dh][^>]*>([\s\S]*?)</t[dh]>", row_match.group(1), re.IGNORECASE)
            ])
        if len(rows) < 2:
            continue
        headers = [header.lower() for header in rows[0]]
        for row in rows[1:]:
            item: dict[str, str] = {}
            for field in fields:
                index = next((i for i, header in enumerate(headers) if any(key in header for key in _field_keys(field))), -1)
                if index >= 0 and index < len(row) and row[index]:
                    item[field] = row[index][:500]
            if item:
                items.append(item)
    return items


# 提取产品卡片、列表项或 article 中的字段。
def _extract_block_items(page: str, fields: list[str]) -> list[dict[str, str]]:
    items: list[dict[str, str]] = []
    pattern = re.compile(
        r'<(article|li|div|section)[^>]*(?:class|id|itemtype)=["\'][^"\']*(?:product|item|card|listing|offer)[^"\']*["\'][^>]*>([\s\S]*?)</\1>',
        re.IGNORECASE,
    )
    for match in pattern.finditer(page):
        item = {}
        for field in fields:
            value = _extract_field(match.group(0), field)
            if value:
                item[field] = value
        if item:
            items.append(item)
    return items


# 从网页 HTML 中提取请求字段。
def extract_structured_items(page: str, fields: list[str]) -> list[dict[str, str]]:
    """从网页 HTML 中提取结构化字段，供测试和工具复用。"""
    table_items = _extract_table_items(page, fields)
    if table_items:
        return table_items
    block_items = _extract_block_items(page, fields)
    if block_items:
        return block_items
    fallback = {field: value for field in fields if (value := _extract_field(page, field))}
    return [fallback] if fallback else []


# 安全抓取网页正文并复检每个重定向目标。
def _fetch_safe_html(url: str) -> str:
    safe, reason = _is_safe_url(url)
    if not safe:
        raise ValueError(f"URL 安全拒绝：{reason}")
    current_url = url
    with httpx.Client(timeout=10, follow_redirects=False) as client:
        for redirects in range(4):
            safe, reason = _is_safe_url(current_url)
            if not safe:
                raise ValueError(f"重定向目标 URL 安全拒绝：{reason}")
            response = client.get(
                current_url,
                headers={"User-Agent": "Mozilla/5.0 (compatible; AI-Agent/1.0)", "Accept": "text/html,text/plain,application/json,*/*"},
            )
            if response.status_code in {301, 302, 303, 307, 308}:
                location = response.headers.get("location")
                if not location:
                    raise ValueError("重定向响应缺少 Location")
                current_url = str(httpx.URL(current_url).join(location))
                continue
            response.raise_for_status()
            content_type = response.headers.get("content-type", "").split(";", 1)[0].lower()
            if content_type and not (content_type.startswith("text/") or content_type in {"application/json", "application/xhtml+xml"}):
                raise ValueError(f"不支持的内容类型：{content_type}")
            return response.text[:MAX_RESPONSE_CHARS]
    raise ValueError("重定向次数超过 3 次")


# 从指定网页提取结构化字段。
@tool(args_schema=WebExtractInput)
# 执行 web extract 对应的业务逻辑
def web_extract(url: str, fields: list[str]) -> str:
    """从网页列表或表格中提取结构化字段。"""
    try:
        return json.dumps({"items": extract_structured_items(_fetch_safe_html(url), fields)}, ensure_ascii=False)
    except Exception as exc:
        return json.dumps({"items": [], "error": f"网页结构化提取失败：{exc!s}"}, ensure_ascii=False)


__all__ = ["_DESCRIPTOR", "WebExtractInput", "extract_structured_items", "web_extract"]
