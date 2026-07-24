"""
RAG Agent — Python 版（LangGraph 显式图）

特点：
- 显式定义图结构：retrieve → grade → generate
- 每一步执行路径由你控制
- 对比 TS 版：Agent 自主决定是否检索
"""

import operator
from typing import Annotated, Any, TypedDict

from langchain_core.messages import BaseMessage
from langchain_openai import ChatOpenAI
from langgraph.graph import END, START, StateGraph

from src.config.settings import settings
from src.rag.retriever import Retriever


class RAGState(TypedDict):
    """RAG Agent 状态"""
    messages: Annotated[list[BaseMessage], operator.add]
    context: list[dict[str, Any]]
    should_retrieve: bool


def build_rag_agent(
    qdrant_url: str = None,
    collection_name: str = "documents",
    top_k: int = 5,
):
    """
    构建 RAG Agent — 显式图编排

    图结构：
    START → agent → should_retrieve?
                ├── true  → retrieve → grade → generate → END
                └── false → generate → END
    """
    llm = ChatOpenAI(model=settings.openai_model)
    retriever = Retriever(
        qdrant_url=qdrant_url or settings.qdrant_url,
        collection_name=collection_name,
        top_k=top_k,
    )

    def agent_node(state: RAGState):
        """Agent 节点：决定是否需要检索"""
        response = llm.invoke(state["messages"])
        return {"messages": [response]}

    def retrieve_node(state: RAGState):
        """检索节点：从向量库获取相关文档"""
        last_message = state["messages"][-1]
        query = last_message.content

        # 异步检索需要在外部处理，这里用同步简化
        import asyncio
        results = asyncio.run(retriever.retrieve(query))

        context = [r["content"] for r in results]
        return {"context": context}

    def grade_node(state: RAGState):
        """判断检索结果是否相关"""
        last_message = state["messages"][-1]
        context = state.get("context", [])

        if not context:
            return {"should_retrieve": False}

        # 简单判断：有检索结果就认为相关
        # 实际项目中可以用 LLM 判断相关性
        return {"should_retrieve": len(context) > 0}

    def generate_node(state: RAGState):
        """生成节点：基于检索结果生成回答"""
        context = state.get("context", [])
        last_message = state["messages"][-1]

        # 构建带上下文的 prompt
        context_text = "\n\n".join(context) if context else "No relevant information found."

        prompt = f"""Based on the following context from the company knowledge base, answer the user's question.
If the context doesn't contain relevant information, say so honestly.

Context:
{context_text}

Question: {last_message.content}

Answer:"""

        response = llm.invoke(prompt)
        return {"messages": [response]}

    def should_retrieve(state: RAGState) -> str:
        """条件路由：判断是否需要检索"""
        if state.get("should_retrieve"):
            return "retrieve"
        return "generate"

    def should_generate(state: RAGState) -> str:
        """条件路由：判断是否需要重新检索"""
        if state.get("should_retrieve") and not state.get("context"):
            return "retrieve"
        return "generate"

    # 构建图
    builder = StateGraph(RAGState)

    builder.add_node("agent", agent_node)
    builder.add_node("retrieve", retrieve_node)
    builder.add_node("grade", grade_node)
    builder.add_node("generate", generate_node)

    # 显式定义边
    builder.add_edge(START, "agent")
    builder.add_conditional_edges("agent", should_retrieve, {
        "retrieve": "retrieve",
        "generate": "generate",
    })
    builder.add_edge("retrieve", "grade")
    builder.add_conditional_edges("grade", should_generate, {
        "retrieve": "retrieve",
        "generate": "generate",
    })
    builder.add_edge("generate", END)

    return builder.compile()
