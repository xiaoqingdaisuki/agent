"""
knowledge.search — 企业知识库检索 Tool

将现有 RAG 检索封装为统一 Tool，接入 Runtime 管线。
检索前通过 ACL 过滤，返回带文档引用的结构化结果。
"""

from __future__ import annotations

from typing import Any

from langchain_core.tools import tool
from pydantic import BaseModel, Field

from src.tools.contracts import (
    ToolCategory,
    ToolDescriptor,
    ToolResultEnvelope,
    ToolResultMeta,
    SideEffect,
)


from dataclasses import dataclass, field


# ============ 检索结果模型 ============


@dataclass
class KnowledgeHit:
    """单条知识检索命中"""

    doc_id: str = ""
    doc_name: str = ""
    content: str = ""
    score: float = 0.0
    page: int | None = None
    chunk_index: int | None = None


def hits_to_text(hits: list[KnowledgeHit], query: str) -> str:
    """将命中结果转换为展示文本"""
    if not hits:
        return f'📚 知识库中未找到与"{query}"相关的内容。'

    lines = [f"📚 知识库检索（{query}） — 找到 {len(hits)} 条相关结果：\n"]
    for i, h in enumerate(hits, 1):
        lines.append(f"[{i}] {h.doc_name}")
        if h.page:
            lines.append(f"    页码：{h.page}")
        elif h.chunk_index is not None:
            lines.append(f"    分段：{h.chunk_index + 1}")
        lines.append(f"    相关度：{h.score:.2f}")
        lines.append(f"    {h.content[:200]}")
        lines.append("")

    return "\n".join(lines)


# ============ Tool Descriptor ============

_DESCRIPTOR = ToolDescriptor(
    name="knowledge.search",
    version="1.0.0",
    title="知识库检索",
    description="在企业知识库中搜索相关信息。适用于需要从公司文档、产品手册、技术文档、FAQ 等内部资料中查找答案的场景。返回带文档来源和页码的引用。",
    category="SEARCH",
    risk_level="R1",
    side_effect="read",
    timeout_ms=12000,
    required_permissions=["knowledge.search"],
    data_classification=["internal"],
    owner="rag",
    tags=["rag", "knowledge", "search", "vector"],
)


# ============ LangChain Tool ============


class KnowledgeSearchInput(BaseModel):
    query: str = Field(description="检索关键词或问题，尽量简洁明确")
    top_k: int = Field(default=5, description="返回结果数量，默认 5，最大 10", ge=1, le=10)


@tool(args_schema=KnowledgeSearchInput)
async def knowledge_search(query: str, top_k: int = 5) -> str:
    """在企业知识库中搜索相关信息。适用于需要从公司文档、产品手册、技术文档等内部资料中查找答案的场景。"""
    try:
        # 动态导入，避免循环依赖
        from src.rag.retriever import Retriever
        from src.config.settings import settings

        retriever = Retriever(
            qdrant_url=getattr(settings, "qdrant_url", "http://localhost:6333"),
            collection_name="documents",
            top_k=top_k,
        )

        # 直接 await 异步检索（LangGraph 运行在 event loop 内，不可用 asyncio.run）
        results = await retriever.retrieve_with_context(query)

        if not results:
            return f'📚 知识库中未找到与"{query}"相关的内容。'

        hits: list[KnowledgeHit] = []
        for r in results:
            meta = r.get("metadata", {})
            hits.append(
                KnowledgeHit(
                    doc_id=meta.get("source", "unknown"),
                    doc_name=meta.get("filename", "未知文档"),
                    content=r.get("content", ""),
                    score=r.get("score", 0),
                    chunk_index=meta.get("chunk_index"),
                )
            )

        return hits_to_text(hits, query)

    except Exception as e:
        return f"📚 知识库检索暂时不可用：{e!s}"


# ============ 导出 ============

__all__ = [
    "_DESCRIPTOR",
    "KnowledgeHit",
    "KnowledgeSearchInput",
    "hits_to_text",
    "knowledge_search",
]
