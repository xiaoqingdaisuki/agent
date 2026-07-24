"""
RAG 向量化器
使用 OpenAI Embedding 模型
"""


from langchain_openai import OpenAIEmbeddings


class Embedder:
    """OpenAI Embedding 向量化器"""

    def __init__(
        self,
        model: str = "text-embedding-3-small",
        api_key: str | None = None,
        base_url: str | None = None,
    ):
        self.embeddings = OpenAIEmbeddings(
            model=model,
            openai_api_key=api_key,
            openai_base_url=base_url,
        )
        self.model = model

    async def embed(self, text: str) -> list[float]:
        """单文本向量化"""
        result = await self.embeddings.aembed_query(text)
        return result

    async def embed_batch(self, texts: list[str]) -> list[list[float]]:
        """批量向量化"""
        results = []
        for text in texts:
            embedding = await self.embed(text)
            results.append(embedding)
        return results

    def embed_sync(self, text: str) -> list[float]:
        """同步向量化"""
        return self.embeddings.embed_query(text)

    def embed_batch_sync(self, texts: list[str]) -> list[list[float]]:
        """同步批量向量化"""
        return self.embeddings.embed_documents(texts)
