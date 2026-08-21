"""Tests for service layer"""

import asyncio

import pytest
from src.services import (
    BusinessError,
    BusinessErrorCode,
    AgentService,
    ConversationService,
    Conversation,
    KnowledgeService,
)


class TestBusinessError:
    def test_create_error(self):
        """Should create error with code, message, and status"""
        err = BusinessError(BusinessErrorCode.NOT_FOUND, "Not found", 404)
        assert err.code == BusinessErrorCode.NOT_FOUND
        assert err.message == "Not found"
        assert err.status_code == 404

    def test_to_dict(self):
        """Should serialize to dict"""
        err = BusinessError(BusinessErrorCode.INVALID_REQUEST, "Bad request", 400)
        result = err.to_dict()
        assert result["error"]["code"] == BusinessErrorCode.INVALID_REQUEST.value
        assert result["error"]["message"] == "Bad request"

    def test_inherits_from_exception(self):
        """Should be catchable as Exception"""
        with pytest.raises(BusinessError):
            raise BusinessError(BusinessErrorCode.INTERNAL_ERROR, "Test error")


class TestConversationService:
    def test_create_conversation(self):
        """Should create a conversation with default mode"""
        conv = ConversationService.create("Test Chat")
        assert conv.title == "Test Chat"
        assert conv.mode == "chat"
        assert conv.id is not None
        assert conv.created_at is not None

    def test_create_conversation_with_mode(self):
        """Should create a conversation with custom mode"""
        conv = ConversationService.create("Knowledge Chat", mode="knowledge")
        assert conv.mode == "knowledge"

    def test_get_conversation(self):
        """Should retrieve a created conversation"""
        conv = ConversationService.create("Test")
        retrieved = ConversationService.get(conv.id)
        assert retrieved is not None
        assert retrieved.title == "Test"

    def test_get_nonexistent_conversation(self):
        """Should return None for non-existent conversation"""
        result = ConversationService.get("nonexistent_id")
        assert result is None

    def test_list_conversations(self):
        """Should list all conversations"""
        ConversationService.create("Conv 1")
        import time; time.sleep(0.01)
        ConversationService.create("Conv 2")
        convs = ConversationService.list()
        assert len(convs) >= 2

    def test_list_isolation_and_ensure_ownership(self):
        """Only expose the requested user's conversations and reject ID takeover."""
        owned = ConversationService.create("Private", user_id="owner-a")
        other = ConversationService.create("Other", user_id="owner-b")

        visible = ConversationService.list("owner-a")
        assert owned.id in {item["id"] for item in visible}
        assert other.id not in {item["id"] for item in visible}
        with pytest.raises(BusinessError) as error:
            ConversationService.ensure(owned.id, user_id="owner-b")
        assert error.value.code == BusinessErrorCode.FORBIDDEN
        assert error.value.status_code == 403

    def test_delete_conversation(self):
        """Should delete a conversation"""
        conv = ConversationService.create("To Delete")
        result = ConversationService.delete(conv.id)
        assert result is True
        assert ConversationService.get(conv.id) is None

    def test_delete_nonexistent_conversation(self):
        """Should return False when deleting non-existent conversation"""
        result = ConversationService.delete("nonexistent_id")
        assert result is False

    def test_append_user_message(self):
        """Should append a user message to conversation"""
        conv = ConversationService.create("Test")
        initial_count = conv.message_count
        msg = ConversationService.append_user_message(conv.id, "Hello")
        assert msg.role == "user"
        assert msg.content == "Hello"
        assert conv.message_count == initial_count + 1

    def test_append_message_to_nonexistent_conversation(self):
        """Should raise error when appending to non-existent conversation"""
        with pytest.raises(BusinessError) as exc_info:
            ConversationService.append_user_message("nonexistent_id", "Hello")
        assert exc_info.value.code == BusinessErrorCode.NOT_FOUND

    def test_message_history_can_be_read_and_cleared(self):
        conv = ConversationService.create("History")
        ConversationService.append_user_message(conv.id, "Hello")
        from src.services import Message

        ConversationService.append_assistant_message(conv.id, Message("assistant", "Hi"))
        assert [message["content"] for message in ConversationService.get_messages(conv.id)] == [
            "Hello",
            "Hi",
        ]
        ConversationService.clear_messages(conv.id)
        assert ConversationService.get_messages(conv.id) == []
        assert conv.message_count == 0


class TestAgentService:
    @pytest.mark.asyncio
    async def test_chat_returns_explicit_timeout_error(self, monkeypatch):
        from src.agents import graph_agents
        from src.config.settings import settings

        class SlowAgent:
            async def ainvoke(self, *_args, **_kwargs):
                await asyncio.sleep(1)

        conversation = ConversationService.create("deadline")
        monkeypatch.setattr(graph_agents, "build_tool_agent", lambda **_kwargs: SlowAgent())
        monkeypatch.setattr(settings, "agent_deadline_ms", 5)

        with pytest.raises(BusinessError) as error:
            await AgentService.chat(conversation.id, "正常问题")

        assert error.value.code == BusinessErrorCode.AGENT_TIMEOUT
        assert error.value.status_code == 504

    @pytest.mark.asyncio
    async def test_streamed_knowledge_conversation_uses_rag(self, monkeypatch):
        """Knowledge streaming must use the same RAG path as non-streaming chat."""
        from langchain_core.messages import AIMessage
        from src.agents import graph_agents
        from src.rag import rag_agent

        class FakeRagAgent:
            async def ainvoke(self, _state):
                return {"messages": [AIMessage(content="knowledge answer")]}

        conversation = ConversationService.create(
            "Knowledge", mode="knowledge", user_id="knowledge-user"
        )
        monkeypatch.setattr(rag_agent, "build_rag_agent", lambda: FakeRagAgent())
        monkeypatch.setattr(
            graph_agents,
            "build_tool_agent",
            lambda **_kwargs: pytest.fail("knowledge stream used the tool agent"),
        )

        events = [
            event
            async for event in AgentService.chat_stream(
                conversation.id, "question"
            )
        ]

        assert events == [{"type": "text", "text": "knowledge answer"}]

    @pytest.mark.asyncio
    async def test_tool_only_stream_emits_fallback_answer(self, monkeypatch):
        """Tool-only streams must still end with visible assistant text."""
        from src.agents import graph_agents
        from langchain_core.messages import AIMessage

        class FakeAgent:
            async def astream(self, *_args, **_kwargs):
                yield {
                    "agent": {
                        "messages": [
                            AIMessage(
                                content="",
                                tool_calls=[{
                                    "name": "calculator",
                                    "args": {},
                                    "id": "call-contract",
                                }],
                            )
                        ]
                    }
                }

        conversation = ConversationService.create("tool stream")
        monkeypatch.setattr(graph_agents, "build_tool_agent", lambda **_kwargs: FakeAgent())

        events = [
            event
            async for event in AgentService.chat_stream(
                conversation.id, "calculate"
            )
        ]

        assert events == [
            {
                "type": "tool",
                "tool_name": "calculator",
                "status": "started",
                "call_id": "call-contract",
            },
            {"type": "text", "text": "抱歉，我没有理解您的问题。"},
        ]

    @pytest.mark.asyncio
    async def test_stream_ignores_tool_message_as_final_answer(self, monkeypatch):
        """Tool node output must not be mistaken for the assistant's final answer."""
        from langchain_core.messages import ToolMessage
        from src.agents import graph_agents

        class FakeAgent:
            async def astream_events(self, *_args, **_kwargs):
                yield {
                    "event": "on_chain_end",
                    "data": {
                        "output": {
                            "messages": [
                                ToolMessage(
                                    content="internal memory result",
                                    tool_call_id="call-tool-result",
                                )
                            ]
                        }
                    },
                }

        conversation = ConversationService.create("tool output stream")
        monkeypatch.setattr(graph_agents, "build_tool_agent", lambda **_kwargs: FakeAgent())

        events = [
            event
            async for event in AgentService.chat_stream(
                conversation.id, "who am I?"
            )
        ]

        assert events == [{"type": "text", "text": "抱歉，我没有理解您的问题。"}]

    @pytest.mark.asyncio
    async def test_stream_treats_whitespace_around_xml_as_empty(self, monkeypatch):
        """Whitespace left after filtering an XML tool call must not count as an answer."""
        from langchain_core.messages import AIMessage
        from src.agents import graph_agents

        class FakeAgent:
            async def astream_events(self, *_args, **_kwargs):
                yield {
                    "event": "on_chat_model_stream",
                    "data": {
                        "chunk": AIMessage(
                            content='\n<invoke name="memory_user_search"></invoke>\n'
                        )
                    },
                }

        conversation = ConversationService.create("xml-only stream")
        monkeypatch.setattr(graph_agents, "build_tool_agent", lambda **_kwargs: FakeAgent())

        events = [
            event
            async for event in AgentService.chat_stream(
                conversation.id, "who am I?"
            )
        ]

        assert events == [{"type": "text", "text": "抱歉，我没有理解您的问题。"}]

    @pytest.mark.asyncio
    async def test_stream_returns_visible_text_when_tool_request_times_out(self, monkeypatch):
        """A timeout before the first answer must not become an empty SSE stream."""
        from src.agents import graph_agents

        class FakeAgent:
            async def astream_events(self, *_args, **_kwargs):
                raise TimeoutError
                yield  # Make this an async generator for the stream contract.

        conversation = ConversationService.create("timeout stream")
        monkeypatch.setattr(graph_agents, "build_tool_agent", lambda **_kwargs: FakeAgent())

        events = [
            event
            async for event in AgentService.chat_stream(
                conversation.id, "南山有什么好吃的？"
            )
        ]

        assert events == [{"type": "text", "text": "AI助手响应超时，请稍后重试。"}]


class TestKnowledgeService:
    @pytest.mark.asyncio
    async def test_upload_builds_business_document(self, monkeypatch):
        document = await KnowledgeService.upload_document(b"hello world", "note.txt")
        assert document.name == "note.txt"
        assert document.chunks == 3
        assert document.id.startswith("doc_")
