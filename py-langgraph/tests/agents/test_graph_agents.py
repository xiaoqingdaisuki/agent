"""Tests for agent builder"""

import pytest
from unittest.mock import patch, MagicMock


class TestBuildChatAgent:
    @pytest.mark.asyncio
    async def test_returns_compiled_graph(self):
        """build_chat_agent should return a compiled LangGraph agent"""
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
        """build_tool_agent should return a compiled LangGraph agent"""
        with patch("langchain_openai.ChatOpenAI") as MockLLM:
            mock_llm = MagicMock()
            mock_llm.invoke.return_value = MagicMock(content="Hello!", tool_calls=[])
            MockLLM.return_value = mock_llm

            from src.agents.graph_agents import build_tool_agent
            agent = build_tool_agent()

            assert agent is not None


class TestMemoryModule:
    def test_get_default_checkpointer(self):
        """Should return the persistent D1 checkpointer"""
        from src.memory import get_default_checkpointer
        from src.memory.d1_checkpointer import D1Checkpointer

        saver = get_default_checkpointer()
        assert isinstance(saver, D1Checkpointer)

    def test_get_default_checkpointer_is_singleton(self):
        """Should return the same instance on repeated calls"""
        from src.memory import get_default_checkpointer

        saver1 = get_default_checkpointer()
        saver2 = get_default_checkpointer()
        assert saver1 is saver2
