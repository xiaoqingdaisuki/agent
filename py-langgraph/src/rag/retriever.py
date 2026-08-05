"""
RAG 检索器 — Cloudflare Service（通过 Memory Gateway）
"""

from src.rag.vector_store import VectorStore


class Retriever:
    """RAG 检索器"""

    def __init__(
        self,
        qdrant_url: str = "",
        collection_name: str = "documents",
        top_k: int = 5,
    ):
        # 保持接口兼容，qdrant_url 参数保留但不使用
        self._vector_store = VectorStore(
            url=qdrant_url,
            collection_name=collection_name,
        )
        self._top_k = top_k

    async def retrieve(self, query: str) -> list[dict]:
        """检索相关文档"""
        return await self._vector_store.search(query, top_k=self._top_k)

    async def retrieve_with_context(self, query: str, top_k: int | None = None) -> list[dict]:
        """检索并返回格式化的结果"""
        results = await self.retrieve(query)

        return [
            {
                "content": r["content"],
                "score": r["score"],
                "metadata": r.get("metadata", {}),
            }
            for r in results
        ]
