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
    Message,
    _accept_tool_lifecycle_event,
    extract_agent_output_text,
    flush_background_tasks,
)


def test_nested_tool_lifecycle_is_emitted_once():
    active_run_ids = set()
    completed_run_ids = set()
    events = [
        {"event": "on_tool_start", "run_id": "outer", "parent_ids": []},
        {"event": "on_tool_start", "run_id": "inner", "parent_ids": ["outer"]},
        {"event": "on_tool_end", "run_id": "inner", "parent_ids": ["outer"]},
        {"event": "on_tool_end", "run_id": "outer", "parent_ids": []},
    ]

    accepted = [
        event["run_id"]
        for event in events
        if _accept_tool_lifecycle_event(event, active_run_ids, completed_run_ids)
    ]

    assert accepted == ["outer", "outer"]


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


class TestAgentOutputExtraction:
    def test_does_not_expose_user_message_as_agent_answer(self):
        assert (
            extract_agent_output_text(
                {
                    "output": "__end__",
                    "messages": [{"role": "user", "content": "calculate 12345 * 12"}],
                }
            )
            == ""
        )


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

    def test_agent_history_reads_the_newest_persisted_page(self):
        conv = ConversationService.create("Recent history")
        for index in range(210):
            ConversationService.append_user_message(conv.id, f"question {index}")
            ConversationService.append_assistant_message(
                conv.id, Message("assistant", f"answer {index}")
            )

        history = ConversationService.get_agent_conversation_history(conv.id)

        assert history[-1]["content"] == "answer 209"
        assert {item["content"] for item in history}.isdisjoint({"question 0", "answer 0"})


class TestAgentService:
    @pytest.mark.asyncio
    async def test_chat_passes_persisted_history_as_supplemental_context(self, monkeypatch):
        """跨轮请求必须把已持久化的会话记录传给 Agent。"""
        from langchain_core.messages import AIMessage
        from src.agents import graph_agents

        captured = {}

        class FakeAgent:
            async def ainvoke(self, payload, **_kwargs):
                captured.update(payload)
                return {"messages": [AIMessage(content="当前回答")]}

        conversation = ConversationService.create("history context")
        ConversationService.append_user_message(conversation.id, "上一篇问题")
        ConversationService.append_assistant_message(
            conversation.id,
            Message("assistant", "上一篇回答"),
        )
        monkeypatch.setattr(graph_agents, "build_chat_agent", lambda **_kwargs: FakeAgent())
        monkeypatch.setattr(graph_agents, "is_direct_chat_message", lambda _content: True)

        reply = await AgentService.chat(conversation.id, "当前问题")
        await flush_background_tasks()

        assert reply.content == "当前回答"
        assert captured["conversation_history"] == [
            {"role": "user", "content": "上一篇问题"},
            {"role": "assistant", "content": "上一篇回答"},
        ]

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
    async def test_non_streamed_knowledge_conversation_scopes_rag_to_user(self, monkeypatch):
        from langchain_core.messages import AIMessage
        from src.rag import rag_agent

        captured = {}

        class FakeRagAgent:
            async def ainvoke(self, state):
                captured.update(state)
                return {"messages": [AIMessage(content="knowledge answer")]}

        conversation = ConversationService.create(
            "Knowledge", mode="knowledge", user_id="knowledge-user"
        )
        monkeypatch.setattr(rag_agent, "build_rag_agent", lambda: FakeRagAgent())

        reply = await AgentService.chat(
            conversation.id, "question", user_id="knowledge-user"
        )

        assert reply.content == "knowledge answer"
        assert captured["user_id"] == "knowledge-user"

    @pytest.mark.asyncio
    async def test_explicit_knowledge_query_skips_model_planning(self, monkeypatch):
        from src.agents import graph_agents

        conversation = ConversationService.create("explicit knowledge")

        async def fake_knowledge_chat(content, _history=None, user_id=""):
            assert "知识库" in content
            assert user_id == "knowledge-user"
            return {"output": "没有检索到"}

        monkeypatch.setattr(KnowledgeService, "chat", fake_knowledge_chat)
        monkeypatch.setattr(
            graph_agents,
            "build_tool_agent",
            lambda **_kwargs: pytest.fail("explicit knowledge query used model planning"),
        )

        events = [
            event
            async for event in AgentService.chat_stream(
                conversation.id,
                "请从知识库查询 Agent 项目整改",
                user_id="knowledge-user",
                tool_identity={"tenant_id": "tenant:test", "roles": ["member"]},
            )
        ]

        assert events == [{"type": "text", "text": "没有检索到"}]

    @pytest.mark.asyncio
    async def test_profile_enrichment_failure_does_not_fail_answer(self, monkeypatch):
        from src.agents import graph_agents
        from src.profile.service import ProfileService

        conversation = ConversationService.create("background enrichment")
        monkeypatch.setattr(graph_agents, "get_fast_path_answer", lambda _content: "快速回答")
        monkeypatch.setattr(
            ProfileService,
            "update",
            lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("profile unavailable")),
        )

        reply = await AgentService.chat(conversation.id, "你好", user_id="profile-user")

        assert reply.content == "快速回答"
        await flush_background_tasks()

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
                    "event": "on_chat_model_end",
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
    async def test_stream_extracts_final_ai_answer_after_tool_call(self, monkeypatch):
        """A final AI message after a tool call must be exposed to the client."""
        from src.agents import graph_agents
        from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

        class FakeAgent:
            async def astream_events(self, *_args, **_kwargs):
                yield {
                    "event": "on_chain_end",
                    "data": {
                        "output": {
                            "messages": [
                                HumanMessage(content="深圳南山有什么好吃的和好玩的"),
                                ToolMessage(
                                    content="南山公园、海上世界",
                                    tool_call_id="call-travel",
                                ),
                                AIMessage(content="可以安排南山公园和海上世界两天行程。"),
                            ]
                        }
                    },
                }

        conversation = ConversationService.create("travel plan stream")
        monkeypatch.setattr(graph_agents, "build_tool_agent", lambda **_kwargs: FakeAgent())

        events = [
            event
            async for event in AgentService.chat_stream(
                conversation.id, "深圳南山有什么好吃的和好玩的"
            )
        ]

        assert "".join(event["text"] for event in events) == "可以安排南山公园和海上世界两天行程。"

    @pytest.mark.asyncio
    async def test_stream_does_not_prepend_nested_history_snapshot(self, monkeypatch):
        """Nested chain snapshots must never become part of the current answer."""
        from langchain_core.messages import AIMessage, HumanMessage
        from src.agents import graph_agents
        from src.services import flush_background_tasks

        class FakeAgent:
            async def astream_events(self, *_args, **_kwargs):
                yield {
                    "event": "on_chain_end",
                    "run_id": "nested-history",
                    "parent_ids": ["root-agent"],
                    "data": {"output": {"messages": [AIMessage(content="上一轮完整回答")]}},
                }
                yield {
                    "event": "on_chat_model_stream",
                    "run_id": "current-model",
                    "parent_ids": ["root-agent"],
                    "data": {"chunk": AIMessage(content="当前轮回答")},
                }
                yield {
                    "event": "on_chat_model_end",
                    "run_id": "current-model",
                    "parent_ids": ["root-agent"],
                    "data": {"output": AIMessage(content="当前轮回答")},
                }
                yield {
                    "event": "on_chain_end",
                    "run_id": "root-agent",
                    "parent_ids": [],
                    "data": {
                        "output": {
                            "messages": [
                                AIMessage(content="上一轮完整回答"),
                                HumanMessage(content="当前问题"),
                                AIMessage(content="当前轮回答"),
                            ]
                        }
                    },
                }

        conversation = ConversationService.create("history snapshot regression")
        monkeypatch.setattr(graph_agents, "build_tool_agent", lambda **_kwargs: FakeAgent())

        events = [
            event
            async for event in AgentService.chat_stream(conversation.id, "当前问题")
        ]
        await flush_background_tasks()

        assert "".join(
            event["text"] for event in events if event["type"] == "text"
        ) == "当前轮回答"
        assert ConversationService.get_messages(conversation.id) == []

    @pytest.mark.asyncio
    async def test_stream_uses_root_tool_answer_after_nested_history(self, monkeypatch):
        """A tool answer must come from the root graph result, not an inner history snapshot."""
        from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
        from src.agents import graph_agents

        class FakeAgent:
            async def astream_events(self, *_args, **_kwargs):
                yield {
                    "event": "on_chain_end",
                    "run_id": "nested-history",
                    "parent_ids": ["root-agent"],
                    "data": {"output": {"messages": [AIMessage(content="上一轮完整回答")]}},
                }
                yield {
                    "event": "on_tool_start",
                    "name": "web_search",
                    "run_id": "call-shenzhen",
                    "parent_ids": ["root-agent"],
                }
                yield {
                    "event": "on_tool_end",
                    "name": "web_search",
                    "run_id": "call-shenzhen",
                    "parent_ids": ["root-agent"],
                }
                yield {
                    "event": "on_chain_end",
                    "run_id": "root-agent",
                    "parent_ids": [],
                    "data": {
                        "output": {
                            "messages": [
                                AIMessage(content="上一轮完整回答"),
                                HumanMessage(content="查深圳活动"),
                                ToolMessage(
                                    content="活动搜索结果",
                                    tool_call_id="call-shenzhen",
                                ),
                                AIMessage(content="深圳免费活动回答"),
                            ]
                        }
                    },
                }

        conversation = ConversationService.create("tool history regression")
        monkeypatch.setattr(graph_agents, "build_tool_agent", lambda **_kwargs: FakeAgent())

        events = [
            event
            async for event in AgentService.chat_stream(conversation.id, "查深圳活动")
        ]

        assert "".join(
            event["text"] for event in events if event["type"] == "text"
        ) == "深圳免费活动回答"

    @pytest.mark.asyncio
    async def test_stream_replaces_whitespace_with_final_graph_answer(self, monkeypatch):
        """Whitespace model chunks must not hide the graph's final assistant answer."""
        from langchain_core.messages import AIMessage, ToolMessage
        from src.agents import graph_agents

        class FakeAgent:
            async def astream_events(self, *_args, **_kwargs):
                yield {
                    "event": "on_chain_end",
                    "data": {
                        "output": {
                            "messages": [
                                ToolMessage(
                                    content="计算结果：148140",
                                    tool_call_id="call-calculator",
                                ),
                                AIMessage(content="12345 × 12 = 148140"),
                            ]
                        }
                    },
                }
                yield {
                    "event": "on_chat_model_stream",
                    "data": {"chunk": AIMessage(content="\n\n\n")},
                }

        conversation = ConversationService.create("whitespace before final answer")
        monkeypatch.setattr(graph_agents, "build_tool_agent", lambda **_kwargs: FakeAgent())

        events = [
            event
            async for event in AgentService.chat_stream(conversation.id, "calculate")
        ]

        assert "".join(
            event["text"] for event in events if event["type"] == "text"
        ) == "12345 × 12 = 148140"

    @pytest.mark.asyncio
    async def test_stream_falls_back_to_invoke_for_whitespace_gateway(self, monkeypatch):
        """A gateway with broken tool streaming must use its working invoke path."""
        from langchain_core.messages import AIMessage
        from src.agents import graph_agents

        class FakeAgent:
            async def astream_events(self, *_args, **_kwargs):
                yield {
                    "event": "on_chain_end",
                    "data": {
                        "output": {
                            "messages": [
                                AIMessage(
                                    content=(
                                        "\n<function=calculator>"
                                        "<parameter=expression>12345*12</parameter>"
                                        "</function>\n"
                                    )
                                )
                            ]
                        }
                    },
                }
                yield {
                    "event": "on_chat_model_stream",
                    "data": {"chunk": AIMessage(content="\n\n\n")},
                }

            async def ainvoke(self, *_args, **_kwargs):
                return {"messages": [AIMessage(content="12345 × 12 = 148140")]}

        conversation = ConversationService.create("gateway stream fallback")
        monkeypatch.setattr(graph_agents, "build_tool_agent", lambda **_kwargs: FakeAgent())

        events = [
            event
            async for event in AgentService.chat_stream(conversation.id, "calculate")
        ]

        assert "".join(
            event["text"] for event in events if event["type"] == "text"
        ) == "12345 × 12 = 148140"

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

    @pytest.mark.asyncio
    async def test_stream_timeout_does_not_resend_streamed_text(self, monkeypatch):
        """超时事件只追加提示，不能重复已发送的文本增量。"""
        from langchain_core.messages import AIMessage
        from src.agents import graph_agents

        class FakeAgent:
            async def astream_events(self, *_args, **_kwargs):
                yield {
                    "event": "on_chat_model_stream",
                    "data": {"chunk": AIMessage(content="已输出内容")},
                }
                raise TimeoutError

        conversation = ConversationService.create("partial timeout")
        monkeypatch.setattr(graph_agents, "build_chat_agent", lambda **_kwargs: FakeAgent())
        monkeypatch.setattr(graph_agents, "is_direct_chat_message", lambda _content: True)

        events = [
            event
            async for event in AgentService.chat_stream(
                conversation.id, "流式超时测试"
            )
        ]

        assert "".join(event["text"] for event in events if event["type"] == "text") == (
            "已输出内容\n\n---\n⚠️ 以上回答尚未完成。如需继续，请回复「继续」。"
        )


class TestKnowledgeService:
    @pytest.mark.asyncio
    async def test_upload_builds_business_document(self, monkeypatch):
        document = await KnowledgeService.upload_document(b"hello world", "note.txt")
        assert document.name == "note.txt"
        assert document.chunks == 3
        assert document.id.startswith("doc_")

    @pytest.mark.asyncio
    async def test_local_document_lifecycle_when_memory_is_disabled(self, monkeypatch):
        from src.config.settings import settings

        monkeypatch.setattr(settings, "memory_enabled", False)
        document = await KnowledgeService.upload_document(
            "本地知识库包含缓存和流式响应。".encode(),
            "local-note.txt",
            "tech",
        )

        assert document.id in {item["id"] for item in await KnowledgeService.list_documents()}
        assert await KnowledgeService.get_document(document.id) is document
        assert (await KnowledgeService.search("缓存", 3))[0]["document_id"] == document.id
        assert (await KnowledgeService.reindex_document(document.id)).chunks == 1
        assert await KnowledgeService.delete_document(document.id) is True
        assert await KnowledgeService.get_document(document.id) is None

    @pytest.mark.asyncio
    async def test_local_documents_are_isolated_by_trusted_user_scope(self, monkeypatch):
        from src.config.settings import settings

        monkeypatch.setattr(settings, "memory_enabled", False)
        owner_id = "owner-a"
        other_id = "owner-b"
        document = await KnowledgeService.upload_document(
            "仅属于第一个用户的隔离知识。".encode(),
            "private-note.txt",
            user_id=owner_id,
        )

        assert document.id in {item["id"] for item in await KnowledgeService.list_documents(owner_id)}
        assert await KnowledgeService.get_document(document.id, other_id) is None
        assert await KnowledgeService.list_documents(other_id) == []
        assert await KnowledgeService.search("隔离知识", user_id=other_id) == []
        assert await KnowledgeService.delete_document(document.id, other_id) is False
        assert await KnowledgeService.delete_document(document.id, owner_id) is True
