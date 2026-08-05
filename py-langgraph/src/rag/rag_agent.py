"""
RAG Agent — Python 版（LangGraph 显式图）

特点：
- 显式定义图结构：retrieve → grade → generate
- 每一步执行路径由你控制
- 对比 TS 版：Agent 自主决定是否检索
- 文档向量存储在 Cloudflare Service（Vectorize），通过 Memory Gateway 访问
"""

import operator
from typing import Annotated, Any, TypedDict

from langchain_core.messages import BaseMessage
from langchain_openai import ChatOpenAI
from langgraph.graph import END, START, StateGraph

from src.rag.retriever import Retriever


class RAGState(TypedDict):
    """RAG Agent 状态"""

    messages: Annotated[list[BaseMessage], operator.add]
    context: list[dict[str, Any]]
    should_retrieve: bool


# 构建 RAG Agent — 显式图编排
def build_rag_agent(
    collection_name: str = "documents",
    top_k: int = 5,
    qdrant_url: str = "",
):
    """
    构建 RAG Agent — 显式图编排

    图结构：
    START → agent → should_retrieve?
                ├── true  → retrieve → grade → generate → END
                └── false → generate → END
    """
    llm = ChatOpenAI(model="gpt-4o-mini")
    retriever = Retriever(
        qdrant_url=qdrant_url,
        collection_name=collection_name,
        top_k=top_k,
    )

    async def retrieve_node(state: RAGState):
        """检索节点：从向量库获取相关文档"""
        last_message = state["messages"][-1]
        query = last_message.content

        results = await retriever.retrieve(query)

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

    async def generate_node(state: RAGState):
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

        response = await llm.ainvoke(prompt)
        return {"messages": [response]}

    # 构建图
    builder = StateGraph(RAGState)

    builder.add_node("retrieve", retrieve_node)
    builder.add_node("grade", grade_node)
    builder.add_node("generate", generate_node)

    # 显式定义边
    builder.add_edge(START, "retrieve")
    builder.add_edge("retrieve", "grade")
    builder.add_edge("grade", "generate")
    builder.add_edge("generate", END)

    return builder.compile()
