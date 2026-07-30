"""
RAG 向量存储 — Qdrant
"""


from qdrant_client import QdrantClient
from qdrant_client.models import Distance, FieldCondition, Filter, MatchValue, PointStruct, VectorParams

from src.rag.embedder import Embedder


class VectorStore:
    """Qdrant 向量存储"""

    def __init__(
        self,
        url: str = "http://localhost:6333",
        api_key: str | None = None,
        collection_name: str = "documents",
    ):
        self.client = QdrantClient(url=url, api_key=api_key)
        self.collection_name = collection_name
        self.embedder = Embedder()

    async def ensure_collection(self, dimensions: int = 1536) -> None:
        """确保 collection 存在"""
        collections = self.client.get_collections().collections
        exists = any(c.name == self.collection_name for c in collections)

        if not exists:
            self.client.create_collection(
                collection_name=self.collection_name,
                vectors_config=VectorParams(size=dimensions, distance=Distance.COSINE),
            )

    async def add_documents(self, chunks: list[dict], content_field: str = "content") -> None:
        """添加文档到向量库"""
        await self.ensure_collection()

        texts = [chunk[content_field] for chunk in chunks]
        embeddings = await self.embedder.embed_batch(texts)

        points = []
        for i, (chunk, embedding) in enumerate(zip(chunks, embeddings)):
            points.append(
                PointStruct(
                    id=hash(chunk.get("id", f"chunk_{i}")) % (2**63),
                    vector=embedding,
                    payload={
                        "content": chunk[content_field],
                        "metadata": chunk.get("metadata", {}),
                    },
                )
            )

        self.client.upsert(collection_name=self.collection_name, points=points)

    async def search(
        self,
        query: str,
        top_k: int = 5,
    ) -> list[dict]:
        """向量搜索"""
        query_embedding = await self.embedder.embed(query)

        results = self.client.search(
            collection_name=self.collection_name,
            query_vector=query_embedding,
            limit=top_k,
        )

        return [
            {
                "content": r.payload.get("content", ""),
                "score": r.score,
                "metadata": r.payload.get("metadata", {}),
            }
            for r in results
        ]

    async def delete_document(self, document_id: str) -> None:
        """删除一份文档的全部向量。"""
        self.client.delete(
            collection_name=self.collection_name,
            points_selector=Filter(
                must=[
                    FieldCondition(
                        key="metadata.document_id",
                        match=MatchValue(value=document_id),
                    )
                ]
            ),
            wait=True,
        )

    def delete_collection(self) -> None:
        """删除 collection"""
        self.client.delete_collection(self.collection_name)
