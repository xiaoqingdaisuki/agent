"""
RAG 检索器
封装向量搜索，对外提供统一接口
"""


from src.rag.vector_store import VectorStore


class Retriever:
    """RAG 检索器"""

    def __init__(
        self,
        qdrant_url: str = "http://localhost:6333",
        collection_name: str = "documents",
        top_k: int = 5,
    ):
        self.vector_store = VectorStore(
            url=qdrant_url,
            collection_name=collection_name,
        )
        self.top_k = top_k

    async def retrieve(self, query: str) -> list[dict]:
        """检索相关文档"""
        return await self.vector_store.search(query, top_k=self.top_k)

    async def retrieve_with_context(
        self, query: str, top_k: int | None = None
    ) -> list[dict]:
        """检索并返回格式化的结果"""
        results = await self.retrieve(query)

        return [
            {
                "content": r["content"],
                "score": r["score"],
                "metadata": r["metadata"],
            }
            for r in results
        ]
