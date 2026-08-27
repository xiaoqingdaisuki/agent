import pytest
from langchain_core.messages import AIMessage, HumanMessage


@pytest.mark.asyncio
async def test_rag_graph_retrieves_before_generation(monkeypatch):
    import src.rag.rag_agent as module

    queries = []

    class FakeRetriever:
        def __init__(self, **kwargs):
            pass

        async def retrieve(self, query, user_id):
            queries.append(query)
            assert user_id == "rag-user"
            return [{"content": "retrieved context"}]

    prompts = []

    class FakeLLM:
        async def ainvoke(self, prompt):
            prompts.append(prompt)
            return AIMessage(content="grounded answer")

    monkeypatch.setattr(module, "Retriever", FakeRetriever)
    monkeypatch.setattr(module, "ChatOpenAI", lambda **kwargs: FakeLLM())

    graph = module.build_rag_agent()
    result = await graph.ainvoke({
        "messages": [HumanMessage(content="question")],
        "context": [],
        "should_retrieve": True,
        "user_id": "rag-user",
    })

    assert queries == ["question"]
    assert result["messages"][-1].content == "grounded answer"
    assert "untrusted data" in prompts[0]
    assert "不可信检索文档" in prompts[0]
