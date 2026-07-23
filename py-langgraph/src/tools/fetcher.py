from langchain_core.tools import tool
from pydantic import BaseModel, Field
import httpx
import re
from html import unescape


class FetchUrlInput(BaseModel):
    url: str = Field(description="要获取内容的网页URL，必须是完整的URL（包含 https:// 或 http://）")


@tool(args_schema=FetchUrlInput)
def fetch_url(url: str) -> str:
    """获取指定网页的文本内容。当需要从网页获取详细信息时使用，通常在 web_search 之后使用。"""
    try:
        with httpx.Client(timeout=10, follow_redirects=True) as client:
            res = client.get(
                url,
                headers={"User-Agent": "Mozilla/5.0 (compatible; AI-Agent/1.0)"},
            )

            if not res.is_success:
                return f"无法获取网页：HTTP {res.status_code}"

            html = res.text

            # Strip HTML tags
            text = re.sub(r"<script[^>]*>.*?</script>", "", html, flags=re.DOTALL)
            text = re.sub(r"<style[^>]*>.*?</style>", "", text, flags=re.DOTALL)
            text = re.sub(r"<[^>]+>", " ", text)
            text = unescape(text)
            text = re.sub(r"\s+", " ", text).strip()

            # Truncate to 5000 chars
            if len(text) > 5000:
                text = text[:5000] + "...\n[内容过长，已截断]"

            if len(text) < 50:
                return f"网页内容过少或无法解析：{text}"

            return f"📄 网页内容（{url}）：\n{text}"
    except Exception as e:
        return f"获取网页出错：{str(e)}"
