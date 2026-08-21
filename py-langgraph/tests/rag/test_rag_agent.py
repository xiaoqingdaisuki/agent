import pytest
from langchain_core.messages import AIMessage, HumanMessage


@pytest.mark.asyncio
async def test_rag_graph_retrieves_before_generation(monkeypatch):
    import src.rag.rag_agent as module

    queries = []

    class FakeRetriever:
        def __init__(self, **kwargs):
            pass

        async def retrieve(self, query):
            queries.append(query)
            return [{"content": "retrieved context"}]

    class FakeLLM:
        async def ainvoke(self, prompt):
            return AIMessage(content="grounded answer")

    monkeypatch.setattr(module, "Retriever", FakeRetriever)
    monkeypatch.setattr(module, "ChatOpenAI", lambda **kwargs: FakeLLM())

    graph = module.build_rag_agent()
    result = await graph.ainvoke({
        "messages": [HumanMessage(content="question")],
        "context": [],
        "should_retrieve": True,
    })

    assert queries == ["question"]
    assert result["messages"][-1].content == "grounded answer"
