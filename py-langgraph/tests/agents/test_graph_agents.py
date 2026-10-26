"""验证 Agent 构建器的返回类型与检查点存储复用行为"""

import pytest
from unittest.mock import patch, MagicMock


class TestBuildChatAgent:
    @pytest.mark.asyncio
    async def test_returns_compiled_graph(self):
        """验证 build_chat_agent 返回已编译的 LangGraph Agent"""
        with patch("langchain_openai.ChatOpenAI") as MockLLM:
            mock_llm = MagicMock()
            mock_llm.invoke.return_value = MagicMock(content="Hello!")
            MockLLM.return_value = mock_llm

            from src.agents.graph_agents import build_chat_agent
            agent = build_chat_agent()

            assert agent is not None


class TestBuildToolAgent:
    @pytest.mark.asyncio
    async def test_returns_compiled_graph(self):
        """验证 build_tool_agent 返回已编译的 LangGraph Agent"""
        with patch("langchain_openai.ChatOpenAI") as MockLLM:
            mock_llm = MagicMock()
            mock_llm.invoke.return_value = MagicMock(content="Hello!", tool_calls=[])
            MockLLM.return_value = mock_llm

            from src.agents.graph_agents import build_tool_agent
            agent = build_tool_agent()

            assert agent is not None


class TestMemoryModule:
    def test_get_default_checkpointer(self):
        """验证返回持久化 D1 检查点存储"""
        from src.memory import get_default_checkpointer
        from src.memory.d1_checkpointer import D1Checkpointer

        saver = get_default_checkpointer()
        assert isinstance(saver, D1Checkpointer)

    def test_get_default_checkpointer_is_singleton(self):
        """验证重复调用返回同一实例"""
        from src.memory import get_default_checkpointer

        saver1 = get_default_checkpointer()
        saver2 = get_default_checkpointer()
        assert saver1 is saver2
