"""
RAG 向量化器
使用 OpenAI Embedding 模型
"""

from typing import List, Optional
from langchain_openai import OpenAIEmbeddings


class Embedder:
    """OpenAI Embedding 向量化器"""

    def __init__(
        self,
        model: str = "text-embedding-3-small",
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
    ):
        self.embeddings = OpenAIEmbeddings(
            model=model,
            openai_api_key=api_key,
            openai_base_url=base_url,
        )
        self.model = model

    async def embed(self, text: str) -> List[float]:
        """单文本向量化"""
        result = await self.embeddings.aembed_query(text)
        return result

    async def embed_batch(self, texts: List[str]) -> List[List[float]]:
        """批量向量化"""
        results = []
        for text in texts:
            embedding = await self.embed(text)
            results.append(embedding)
        return results

    def embed_sync(self, text: str) -> List[float]:
        """同步向量化"""
        return self.embeddings.embed_query(text)

    def embed_batch_sync(self, texts: List[str]) -> List[List[float]]:
        """同步批量向量化"""
        return self.embeddings.embed_documents(texts)
