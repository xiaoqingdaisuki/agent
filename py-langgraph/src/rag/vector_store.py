"""
RAG 向量存储 — Cloudflare Service（通过 Memory Gateway）
"""

from typing import Any

from src.clients.memory_gateway import CloudflareMemoryClient
from src.config.settings import settings


class VectorStore:
    """通过 Cloudflare Service Gateway 操作文档向量"""

    # 初始化当前对象
    def __init__(
        self,
        url: str = "",
        api_key: str | None = None,
        collection_name: str = "documents",
    ):
        # 保持接口兼容，实际参数来自 CloudflareMemoryClient
        self._client = CloudflareMemoryClient(
            base_url=url or settings.memory_gateway_base_url,
            secret=api_key or settings.memory_gateway_secret,
        )
        self._collection_name = collection_name

    # 执行 ensure collection 对应的业务逻辑
    async def ensure_collection(self, dimensions: int = 1536) -> None:
        """确保 collection 存在（Cloudflare Vectorize 无需手动创建）"""
        return

    # 创建或注册 add documents 所需的数据
    async def add_documents(self, chunks: list[dict], content_field: str = "content") -> None:
        """上传文档到 Cloudflare Service"""
        import base64
        import hashlib

        # 将块内容合并为完整文档
        full_content = "\n\n".join(chunk[content_field] for chunk in chunks)
        content_hash = hashlib.sha256(full_content.encode()).hexdigest()

        # 取第一个 chunk 的 metadata 中的 document_id 作为文件名
        doc_id = chunks[0].get("metadata", {}).get("document_id", content_hash[:16])

        # 使用默认用户上传（共享知识库）
        await self._client.upload_document(
            user_id="default",
            filename=f"{self._collection_name}_{doc_id}",
            content=base64.b64encode(full_content.encode()).decode(),
            category="general",
        )

    # 查询 search 对应的结果
    async def search(
        self,
        query: str,
        top_k: int = 5,
    ) -> list[dict]:
        """向量搜索文档"""
        result = await self._client.search_documents(
            user_id="default",
            query=query,
            limit=top_k,
        )
        return [
            {
                "content": r["content"],
                "score": r["score"],
                "metadata": r.get("metadata", {}),
            }
            for r in result.get("results", [])
        ]

    # 删除或清理 delete document 对应的数据
    async def delete_document(self, document_id: str) -> None:
        """删除一份文档的全部向量"""
        await self._client.delete_document(document_id)

    # 删除或清理 delete collection 对应的数据
    def delete_collection(self) -> None:
        """删除 collection（Cloudflare Vectorize 不支持前端删除）"""
