from langchain_core.tools import tool
from pydantic import BaseModel, Field
import httpx


class SearchInput(BaseModel):
    query: str = Field(description="搜索关键词，尽量简洁明确")


@tool(args_schema=SearchInput)
def web_search(query: str) -> str:
    """在互联网上搜索最新信息。当用户问及时事、新闻、最新动态、知识查询，或你不知道答案时使用此工具获取最新信息。"""
    try:
        with httpx.Client(timeout=10) as client:
            res = client.get(
                "https://api.duckduckgo.com/",
                params={
                    "q": query,
                    "format": "json",
                    "no_html": 1,
                    "skip_disambig": 1,
                },
            )
            data = res.json()

            results = []

            if data.get("Abstract"):
                results.append(f"📋 摘要：{data['Abstract']}")
                if data.get("AbstractURL"):
                    results.append(f"   来源：{data['AbstractURL']}")

            if data.get("RelatedTopics"):
                results.append("\n📌 相关结果：")
                for topic in data["RelatedTopics"][:5]:
                    if topic.get("Text") and "search for" not in topic["Text"]:
                        results.append(f"• {topic['Text']}")
                        if topic.get("FirstURL"):
                            results.append(f"  链接：{topic['FirstURL']}")

            if not results:
                return f'未找到关于 "{query}" 的相关信息，请尝试其他关键词。'

            return "\n".join(results)
    except Exception as e:
        return f"搜索出错：{str(e)}"
