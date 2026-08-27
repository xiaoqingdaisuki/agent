import pytest

from src.rag.vector_store import VectorStore


@pytest.mark.asyncio
async def test_vector_store_requires_and_forwards_trusted_user_scope(monkeypatch):
    captured = {}

    class FakeClient:
        async def search_documents(self, **kwargs):
            captured.update(kwargs)
            return {"results": []}

    store = VectorStore()
    monkeypatch.setattr(store, "_client", FakeClient())

    await store.search("隔离测试", "tenant-user")
    assert captured["user_id"] == "tenant-user"
    with pytest.raises(ValueError, match="可信用户标识"):
        await store.search("隔离测试", "")
