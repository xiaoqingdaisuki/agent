"""
web.read — 安全读取指定 URL 的网页内容

安全特性:
- SSRF 防护: 仅允许 http/https，拒绝私有 IP、内网地址、本地回环
- 响应大小限制: 最大 200KB
- 内容类型检查: 仅允许 text/*, application/json 等文本类型
- 重定向复检: 跟随重定向后再次检查目标 URL
- 超时控制: 默认 10 秒
"""

from __future__ import annotations

import ipaddress
import re
import socket
from typing import Any
from urllib.parse import urljoin, urlparse

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

# ============ SSRF 防护 ============

_BLOCKED_HOSTS = {
    "localhost",
    "127.0.0.1",
    "0.0.0.0",
    "::1",
    "169.254.169.254",  # AWS metadata
    "metadata.google.internal",  # GCP metadata
}


# 检查 URL 是否安全，防止 SSRF 攻击
def _is_safe_url(url: str) -> tuple[bool, str | None]:
    """检查 URL 是否安全，防止 SSRF 攻击"""
    try:
        parsed = urlparse(url)
    except Exception:
        return False, "URL 格式无效"

    if parsed.scheme not in ("http", "https"):
        return False, f"不支持的协议: {parsed.scheme}（仅允许 http/https）"

    hostname = parsed.hostname
    if not hostname:
        return False, "URL 缺少主机名"

    if hostname.lower() in _BLOCKED_HOSTS:
        return False, f"目标主机在黑名单中: {hostname}"

    if parsed.username or parsed.password:
        return False, "URL 不允许包含用户名或密码"

    try:
        addr = ipaddress.ip_address(hostname)
        if addr.is_private or addr.is_loopback or addr.is_link_local or addr.is_reserved:
            return False, f"目标 IP 是内网/私有地址: {hostname}"
    except ValueError:
        try:
            addresses = {
                item[4][0]
                for item in socket.getaddrinfo(hostname, parsed.port, type=socket.SOCK_STREAM)
            }
        except (OSError, ValueError):
            return False, f"无法解析目标主机: {hostname}"
        for raw_address in addresses:
            address = ipaddress.ip_address(raw_address)
            if (
                address.is_private
                or address.is_loopback
                or address.is_link_local
                or address.is_reserved
                or address.is_multicast
                or address.is_unspecified
            ):
                return False, f"目标域名解析到内网/保留地址: {raw_address}"

    return True, None


# ============ 正文清洗 ============


# 清洗 HTML 文本，去除 script/style 标签并提取正文
def _clean_html(html: str) -> str:
    """提取网页正文，去除 script/style/标签"""
    text = re.sub(r"<script[^>]*>[\s\S]*?</script>", "", html, flags=re.IGNORECASE | re.DOTALL)
    text = re.sub(r"<style[^>]*>[\s\S]*?</style>", "", text, flags=re.IGNORECASE | re.DOTALL)
    text = re.sub(r"<[^>]+>", " ", text)
    text = unescape(text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


# ============ 内容类型判断 ============

_TEXT_CONTENT_TYPES = {
    "text/html",
    "text/plain",
    "text/xml",
    "application/xml",
    "application/json",
    "application/xhtml+xml",
}


# 判断内容类型是否为可读文本类型
def _is_text_content(content_type: str) -> bool:
    ct = content_type.split(";")[0].strip().lower()
    return ct in _TEXT_CONTENT_TYPES or ct.startswith("text/")


# ============ Tool Descriptor ============

_DESCRIPTOR = ToolDescriptor(
    name="web.read",
    version="1.0.0",
    title="网页读取",
    description="读取指定 URL 的网页正文内容。自动去除 HTML 标签、脚本和样式，提取可读文本。用于在 web_search 之后获取网页详细信息。",
    category="READ",
    risk_level="R1",
    side_effect="read",
    timeout_ms=10000,
    required_permissions=["web.read"],
    data_classification=["internal"],
    owner="tools",
    tags=["web", "read", "http"],
)


# ============ LangChain Tool ============


class WebReadInput(BaseModel):
    url: str = Field(description="要读取的网页 URL，必须是完整的 URL（https:// 或 http://）")


# 读取指定 URL 的网页正文内容，通常在 web_search 之后使用
@tool(args_schema=WebReadInput)
def web_read(url: str) -> str:
    """读取指定 URL 的网页正文内容。通常在 web_search 之后使用来获取详细信息。"""
    # 1. URL 安全检查
    safe, reason = _is_safe_url(url)
    if not safe:
        return f"URL 安全拒绝：{reason}"

    # 2. 发起请求
    try:
        with httpx.Client(timeout=10, follow_redirects=False) as client:
            headers = {
                "User-Agent": "Mozilla/5.0 (compatible; AI-Agent/1.0)",
                "Accept": "text/html,application/xhtml+xml,application/xml,text/plain,*/*",
            }
            current_url = url
            for _ in range(4):
                safe, reason = _is_safe_url(current_url)
                if not safe:
                    return f"重定向目标 URL 安全拒绝：{reason}"

                with client.stream("GET", current_url, headers=headers) as resp:
                    if resp.status_code in {301, 302, 303, 307, 308}:
                        location = resp.headers.get("location")
                        if not location:
                            return "无法获取网页：重定向响应缺少 Location"
                        current_url = urljoin(current_url, location)
                        continue

                    if resp.status_code >= 400:
                        return f"无法获取网页：HTTP {resp.status_code}"

                    # 4. 内容类型检查
                    content_type = resp.headers.get("content-type", "")
                    if not _is_text_content(content_type):
                        return f"不支持的内容类型：{content_type}（仅支持文本类内容）"

                    # 5. 流式读取并限制响应体（200KB）
                    max_bytes = 200 * 1024
                    chunks: list[bytes] = []
                    total = 0
                    truncated = False
                    for chunk in resp.iter_bytes():
                        remaining = max_bytes - total
                        if len(chunk) > remaining:
                            chunks.append(chunk[:remaining])
                            truncated = True
                            break
                        chunks.append(chunk)
                        total += len(chunk)
                        if total >= max_bytes:
                            truncated = True
                            break
                    encoding = resp.encoding or "utf-8"
                    content = b"".join(chunks).decode(encoding, errors="replace")
                    if truncated:
                        content += "\n\n[内容过长，已截断]"
                    break
            else:
                return "无法获取网页：重定向次数超过 3 次"

            # 6. 正文提取
            text = _clean_html(content)

            if len(text) < 30:
                return f"网页内容过少或无法解析（{len(text)} 字符）：{text[:200]}"

            title = _extract_title(content)
            header = f"📄 网页内容（{url}）\n"
            if title:
                header += f"标题：{title}\n"
            header += f"大小：{len(text)} 字符\n"
            header += "─" * 40 + "\n\n"

            return header + text

    except httpx.TimeoutException:
        return f"获取网页超时（10秒）：{url}"
    except httpx.HTTPStatusError as e:
        return f"HTTP 错误 {e.response.status_code}：{url}"
    except Exception as e:
        return f"获取网页出错：{e!s}"


# 从 HTML 中提取 <title> 标签的文本
def _extract_title(html: str) -> str | None:
    match = re.search(r"<title[^>]*>([\s\S]*?)</title>", html, re.IGNORECASE | re.DOTALL)
    if match:
        title = re.sub(r"<[^>]+>", "", match.group(1))
        title = unescape(title).strip()
        return title[:200] if title else None
    return None


# ============ 导出 ============

__all__ = ["_DESCRIPTOR", "WebReadInput", "_clean_html", "_is_safe_url", "web_read"]
