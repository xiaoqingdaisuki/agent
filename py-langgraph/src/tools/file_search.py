"""file.search — 当前用户文件内容检索工具。"""

from __future__ import annotations

import json
from typing import Any

from langchain_core.tools import tool
from pydantic import BaseModel, Field

from src.tools.contracts import ToolDescriptor
from src.tools.runtime.executor import get_tool_call_context


class FileSearchInput(BaseModel):
    """文件内容搜索工具的输入模型。"""

    query: str = Field(min_length=1, max_length=500, description="要搜索的文件内容或问题")
    file_ids: list[str] = Field(
        default_factory=list,
        max_length=20,
        description="限定搜索的文件 ID，可留空搜索当前用户的全部文件",
    )
    top_k: int = Field(default=5, ge=1, le=20, description="返回结果数量")


_DESCRIPTOR = ToolDescriptor(
    name="file.search",
    version="1.0.0",
    title="文件内容搜索",
    description="先在当前用户的文件内容中搜索相关片段，返回文件 ID、文件名、页码或位置和原文片段。适合大型 PDF、Word、TXT 等文件的定位，不用于读取全文。",
    category="SEARCH",
    risk_level="R1",
    side_effect="read",
    timeout_ms=15000,
    required_permissions=["file.search"],
    data_classification=["internal"],
    owner="tools",
    tags=["file", "search", "document", "rag"],
)


# 将文档搜索结果转换为 file.search 的稳定 JSON 输出。
def _format_results(results: list[dict[str, Any]], degraded: bool) -> str:
    items = []
    for result in results:
        items.append(
            {
                "file_id": result.get("document_id", ""),
                "filename": result.get("document_name") or "",
                "page": None,
                "position": int(result.get("chunk_index", 0)) + 1,
                "text": result.get("content", ""),
            }
        )
    return json.dumps({"results": items, "degraded": degraded}, ensure_ascii=False)


# 搜索当前可信用户的文件内容，并保留文件来源和位置。
@tool(args_schema=FileSearchInput)
# 执行 file search 对应的业务逻辑
async def file_search(query: str, file_ids: list[str] | None = None, top_k: int = 5) -> str:
    """搜索当前用户文件中的相关片段。"""
    context = get_tool_call_context()
    if context is None or not context.user_id:
        return json.dumps({"results": [], "error": "缺少可信用户上下文，无法搜索用户文件"}, ensure_ascii=False)

    try:
        from src.services import KnowledgeService

        results = await KnowledgeService.search(
            query,
            top_k,
            context.user_id,
            file_ids or None,
        )
        degraded = any(bool(r.get("degraded")) for r in results)
        return _format_results(results, degraded)
    except Exception as exc:
        return json.dumps({"results": [], "error": f"文件搜索暂时不可用：{exc!s}"}, ensure_ascii=False)


__all__ = ["_DESCRIPTOR", "FileSearchInput", "file_search"]
