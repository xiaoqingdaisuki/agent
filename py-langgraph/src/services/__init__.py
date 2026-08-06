"""
Service Layer — 业务逻辑编排

职责：
1. 编排 Agent / RAG / 工具的调用
2. 将内部返回转换为前端友好的格式
3. 错误转换（内部错误 → 业务错误码）
4. 与 API 层解耦，前端看不到内部实现
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime
from enum import Enum
from typing import Optional

logger = logging.getLogger(__name__)

# ============ 错误码 ============


class BusinessErrorCode(str, Enum):
    INVALID_REQUEST = "INVALID_REQUEST"
    UNAUTHORIZED = "UNAUTHORIZED"
    FORBIDDEN = "FORBIDDEN"
    NOT_FOUND = "NOT_FOUND"
    SESSION_EXPIRED = "SESSION_EXPIRED"
    RATE_LIMITED = "RATE_LIMITED"
    INTERNAL_ERROR = "INTERNAL_ERROR"
    SERVICE_UNAVAILABLE = "SERVICE_UNAVAILABLE"
    AGENT_TIMEOUT = "AGENT_TIMEOUT"


class BusinessError(Exception):
    def __init__(self, code: BusinessErrorCode, message: str, status_code: int = 500):
        self.code = code
        self.message = message
        self.status_code = status_code
        super().__init__(message)

    # 将错误序列化为字典响应
    def to_dict(self):
        return {"error": {"code": self.code.value, "message": self.message}}


# ============ 类型定义 ============


class Conversation:
    def __init__(self, title: str, mode: str = "chat"):
        self.id = f"conv_{datetime.now().strftime('%Y%m%d%H%M%S%f')}"
        self.title = title
        self.mode = mode
        self.created_at = datetime.now().isoformat()
        self.message_count = 0
        self.messages: list[Message] = []

    # 将会话对象序列化为字典
    def to_dict(self):
        return {
            "id": self.id,
            "title": self.title,
            "mode": self.mode,
            "created_at": self.created_at,
            "message_count": self.message_count,
        }


class Message:
    def __init__(self, role: str, content: str):
        self.id = f"msg_{datetime.now().strftime('%Y%m%d%H%M%S%f')}"
        self.role = role
        self.content = content
        self.created_at = datetime.now().isoformat()

    # 将消息对象序列化为字典
    def to_dict(self):
        return {
            "id": self.id,
            "role": self.role,
            "content": self.content,
            "created_at": self.created_at,
        }


class Document:
    def __init__(self, name: str, size: int, chunks: int = 0, category: str = None):
        self.id = f"doc_{datetime.now().strftime('%Y%m%d%H%M%S%f')}"
        self.name = name
        self.size = size
        self.status = "indexed"
        self.chunks = chunks
        self.category = category
        self.created_at = datetime.now().isoformat()

    # 将文档对象序列化为字典
    def to_dict(self):
        return {
            "id": self.id,
            "name": self.name,
            "size": self.size,
            "status": self.status,
            "chunks": self.chunks,
            "category": self.category,
            "created_at": self.created_at,
        }


class Capabilities:
    @staticmethod
    def get() -> dict:
        return {
            "modes": ["chat", "knowledge", "mixed"],
            "knowledge": {
                "enabled": True,
                "categories": ["hr", "product", "tech"],
            },
            "tools": [
                {"name": "weather", "description": "天气查询", "available": True},
                {"name": "calculator", "description": "计算器", "available": True},
            ],
        }


# ============ Conversation Service ============

_conversations: dict[str, Conversation] = {}


class ConversationService:
    # 创建新会话并注册到内存存储，同时持久化到 D1
    @staticmethod
    def create(title: str, mode: str = "chat", user_id: str = "") -> Conversation:
        conv = Conversation(title, mode)
        _conversations[conv.id] = conv

        # 持久化到 D1
        if user_id:
            try:
                from src.repositories import get_repositories
                get_repositories().create_conversation(user_id, title, mode)
            except Exception as exc:
                logger.warning("[service] D1 create conversation failed: %s", exc)

        return conv

    @staticmethod
    # 确保会话存在于 D1，不存在则创建；同时注册到内存
    def ensure(conv_id: str, user_id: str = "", title: str = "New Chat", mode: str = "chat") -> Conversation:
        # 先检查 D1
        if user_id:
            try:
                from src.repositories import get_repositories
                existing = get_repositories().get_conversation(conv_id)
                if not existing:
                    get_repositories().create_conversation(user_id, title, mode)
            except Exception as exc:
                logger.warning("[service] D1 ensure conversation %s failed: %s", conv_id, exc)

        # 注册到内存
        if conv_id not in _conversations:
            conv = Conversation(title, mode)
            conv.id = conv_id
            _conversations[conv_id] = conv
        return _conversations[conv_id]

    @staticmethod
    # 根据 ID 获取会话详情，内存未命中时从 D1 加载
    def get(conv_id: str) -> Conversation | None:
        cached = _conversations.get(conv_id)
        if cached:
            return cached

        # D1 回退
        try:
            from src.repositories import get_repositories
            data = get_repositories().get_conversation(conv_id)
            if not data:
                return None
            conv = Conversation(
                title=data.get("title", ""),
                mode=data.get("mode", "chat"),
            )
            conv.id = data["id"]
            _conversations[conv_id] = conv
            return conv
        except Exception as exc:
            logger.warning("[service] D1 get conversation %s failed: %s", conv_id, exc)
            return None

    @staticmethod
    # 列出所有会话，D1 为权威数据源
    def list() -> list[dict]:
        try:
            from src.repositories import get_repositories
            repos = get_repositories()

            # 从已知内存会话中收集 userId
            known_user_ids = {
                c.id: getattr(c, "_user_id", "")
                for c in _conversations.values()
            }

            all_convs: dict[str, dict] = {}

            # 按 userId 从 D1 拉取
            for uid in set(known_user_ids.values()):
                if not uid:
                    continue
                try:
                    items = repos.list_conversations(uid, 100, 0)
                    for item in items:
                        all_convs[item["id"]] = item
                except Exception as exc:
                    logger.warning("[service] D1 list conversations for user %s failed: %s", uid, exc)

            # 合并内存中的无 userId 会话
            for c in _conversations.values():
                if c.id not in all_convs:
                    all_convs[c.id] = c.to_dict()

            # 按创建时间倒序
            return sorted(
                all_convs.values(),
                key=lambda c: c.get("created_at", ""),
                reverse=True,
            )
        except Exception as exc:
            logger.warning("[service] D1 list conversations failed: %s", exc)
            # D1 失败时返回内存数据
            return sorted(
                [c.to_dict() for c in _conversations.values()],
                key=lambda c: c["created_at"],
                reverse=True,
            )

    @staticmethod
    # 删除会话及其关联的消息和命令状态，同时从 D1 删除
    def delete(conv_id: str) -> bool:
        if conv_id in _conversations:
            from src.commands import clear_agent_command_state

            clear_agent_command_state(conv_id)
            del _conversations[conv_id]

            # 从 D1 删除（忽略错误）
            try:
                from src.repositories import get_repositories
                get_repositories().delete_conversation(conv_id)
            except Exception as exc:
                logger.warning("[service] D1 delete conversation %s failed: %s", conv_id, exc)

            return True
        return False

    @staticmethod
    # 向会话追加一条用户消息，同时持久化到 D1
    def append_user_message(conv_id: str, content: str, user_id: str = "") -> Message:
        conv = _conversations.get(conv_id)
        if not conv:
            raise BusinessError(BusinessErrorCode.NOT_FOUND, "Conversation not found", 404)
        conv.message_count += 1
        message = Message("user", content)
        conv.messages.append(message)

        # 持久化到 D1
        try:
            from src.repositories import get_repositories
            repos = get_repositories()
            repos.create_message_batch(conv_id, user_id, [{
                "id": message.id,
                "role": "user",
                "content": content,
                "created_at": message.created_at,
            }])
        except Exception as exc:
            logger.warning("[service] D1 persist user message failed for conv %s: %s", conv_id, exc)

        return message

    @staticmethod
    # 向会话追加一条助手消息，同时持久化到 D1
    def append_assistant_message(conv_id: str, message: Message, user_id: str = "") -> None:
        conv = _conversations.get(conv_id)
        if conv:
            conv.messages.append(message)

        # 持久化到 D1
        try:
            from src.repositories import get_repositories
            repos = get_repositories()
            repos.create_message_batch(conv_id, user_id, [{
                "id": message.id,
                "role": "assistant",
                "content": message.content,
                "created_at": message.created_at,
            }])
        except Exception as exc:
            logger.warning("[service] D1 persist assistant message failed for conv %s: %s", conv_id, exc)

    @staticmethod
    # 获取会话的全部消息列表，内存未命中时从 D1 加载
    def get_messages(conv_id: str) -> list[dict]:
        conv = _conversations.get(conv_id)
        if conv and conv.messages:
            return [message.to_dict() for message in conv.messages]

        # D1 回退
        try:
            from src.repositories import get_repositories
            repos = get_repositories()
            messages_data, _ = repos.get_messages(conv_id, 200, 0)
            loaded = [
                {
                    "id": m["id"],
                    "role": m["role"],
                    "content": m["content_json"],
                    "created_at": m["created_at"],
                }
                for m in messages_data
            ]

            # 写回内存
            if conv:
                from src.services import Message as MessageCls
                conv.messages = [MessageCls(m["role"], m["content_json"]) for m in messages_data]
                conv.messages[-1].id = messages_data[-1]["id"] if messages_data else ""
                conv.messages[-1].created_at = messages_data[-1]["created_at"] if messages_data else ""

            return loaded
        except Exception as exc:
            logger.warning("[service] D1 get messages for conv %s failed: %s", conv_id, exc)
            return []

    @staticmethod
    # 清空会话消息列表和关联状态
    def clear_messages(conv_id: str) -> None:
        conv = _conversations.get(conv_id)
        if conv:
            from src.commands import clear_agent_command_state

            clear_agent_command_state(conv_id)
            conv.messages.clear()
            conv.message_count = 0


# ============ Knowledge Service ============

_documents: dict[str, Document] = {}
_document_contents: dict[str, tuple[bytes, str]] = {}


class KnowledgeService:
    """文档知识库服务 — 通过 Cloudflare Service Gateway"""

    @staticmethod
    async def upload_document(buffer: bytes, filename: str, category: str = None) -> Document:
        """上传并索引文档"""
        try:
            import base64
            import hashlib

            from src.clients.memory_gateway import CloudflareMemoryClient

            client = CloudflareMemoryClient()
            content_hash = hashlib.sha256(buffer).hexdigest()[:16]

            # 使用默认用户上传（共享知识库）
            result = await client.upload_document(
                user_id="default",
                filename=filename,
                content=base64.b64encode(buffer).decode(),
                category=category or "general",
            )

            document = Document(
                id=result["id"],
                name=filename,
                size=len(buffer),
                chunks=result.get("chunk_count", 0),
                category=category,
                status="indexed",
                created_at=result.get("created_at", datetime.now().isoformat()),
            )

            _documents[document.id] = document
            _document_contents[document.id] = (buffer, filename)
            return document

        except Exception as e:
            raise BusinessError(
                BusinessErrorCode.INTERNAL_ERROR,
                f"文档上传失败: {e!s}",
                500,
            )

    @staticmethod
    def list_documents() -> list[dict]:
        """列出所有已索引文档，D1 为权威数据源"""
        try:
            from src.clients.memory_gateway import CloudflareMemoryClient
            client = CloudflareMemoryClient()
            result = client.list_documents("default", limit=100)
            docs = [
                {
                    "id": d["id"],
                    "name": d["name"],
                    "size": d["size"],
                    "status": d["status"],
                    "chunks": d.get("chunk_count", 0),
                    "category": d.get("category"),
                    "created_at": d["created_at"],
                }
                for d in result.get("documents", [])
            ]
            # 写回内存
            for d in docs:
                if d["id"] in _documents:
                    existing = _documents[d["id"]]
                    existing.chunks = d["chunks"]
                    existing.status = d["status"]
                else:
                    doc = Document(
                        name=d["name"],
                        size=d["size"],
                        chunks=d["chunks"],
                        category=d["category"],
                    )
                    doc.id = d["id"]
                    doc.status = d["status"]
                    doc.createdAt = d["created_at"]
                    _documents[d["id"]] = doc

                # 缓存原始内容用于 reindex
                content_text = d.get("content_text", "")
                if content_text:
                    _document_contents[d["id"]] = (content_text.encode("utf-8"), d["name"])
            return sorted(docs, key=lambda d: d["created_at"], reverse=True)
        except Exception:
            return sorted(
                [d.to_dict() for d in _documents.values()],
                key=lambda d: d["created_at"],
                reverse=True,
            )

    @staticmethod
    def get_document(doc_id: str) -> Document | None:
        """获取指定文档详情，内存未命中时从 D1 加载"""
        cached = _documents.get(doc_id)
        if cached:
            return cached

        # D1 回退
        try:
            from src.clients.memory_gateway import CloudflareMemoryClient
            client = CloudflareMemoryClient()
            data = client.get_document(doc_id)
            if not data:
                return None
            doc_data = data.get("document", {})
            doc = Document(
                name=doc_data.get("name", ""),
                size=doc_data.get("size", 0),
                chunks=doc_data.get("chunk_count", 0),
                category=doc_data.get("category"),
            )
            doc.id = doc_data["id"]
            doc.status = doc_data.get("status", "indexed")
            doc.createdAt = doc_data.get("created_at", datetime.now().isoformat())
            _documents[doc_id] = doc

            # 缓存原始内容用于 reindex
            content_text = doc_data.get("content_text", "")
            if content_text:
                _document_contents[doc_id] = (content_text.encode("utf-8"), doc.name)

            return doc
        except Exception:
            return None

    @staticmethod
    async def delete_document(doc_id: str) -> bool:
        """删除指定文档及其向量索引"""
        if doc_id not in _documents:
            return False

        try:
            from src.clients.memory_gateway import CloudflareMemoryClient
            client = CloudflareMemoryClient()
            await client.delete_document(doc_id)
        except Exception:
            pass  # 忽略 Gateway 错误，继续清理本地缓存

        del _documents[doc_id]
        _document_contents.pop(doc_id, None)
        return True

    @staticmethod
    async def reindex_document(doc_id: str) -> Document:
        """重新索引指定文档，内存无内容时从 D1 加载"""
        doc = _documents.get(doc_id)
        if not doc:
            raise BusinessError(BusinessErrorCode.NOT_FOUND, "Document not found", 404)

        source = _document_contents.get(doc_id)
        if source is None:
            # 从 D1 加载原始内容
            try:
                from src.clients.memory_gateway import CloudflareMemoryClient
                client = CloudflareMemoryClient()
                data = client.get_document(doc_id)
                if data and data.get("document", {}).get("content_text"):
                    content_text = data["document"]["content_text"]
                    filename = data["document"].get("filename", doc.name)
                    source = (content_text.encode("utf-8"), filename)
                    _document_contents[doc_id] = source
            except Exception:
                pass

        if source is None:
            raise BusinessError(BusinessErrorCode.NOT_FOUND, "Document content not found in memory or D1", 404)

        try:
            buffer, filename = source
            # 先删除旧索引
            try:
                from src.clients.memory_gateway import CloudflareMemoryClient
                client = CloudflareMemoryClient()
                await client.delete_document(doc_id)
            except Exception:
                pass

            # 重新上传
            return await KnowledgeService.upload_document(buffer, filename, doc.category)
        except Exception as e:
            raise BusinessError(
                BusinessErrorCode.INTERNAL_ERROR,
                f"文档重新索引失败: {e!s}",
                500,
            )

    @staticmethod
    async def search(query: str, top_k: int = 5) -> list[dict]:
        """知识检索"""
        try:
            from src.clients.memory_gateway import CloudflareMemoryClient

            client = CloudflareMemoryClient()
            result = await client.search_documents(
                user_id="default",
                query=query,
                limit=top_k,
            )

            return [
                {
                    "document_id": r.get("document_id", ""),
                    "document_name": r.get("metadata", {}).get("document_name", "") or r.get("metadata", {}).get("filename", ""),
                    "content": r.get("content", ""),
                    "score": r.get("score", 0),
                    "page": r.get("chunk_index"),
                }
                for r in result.get("results", [])
            ]
        except Exception:
            raise BusinessError(
                BusinessErrorCode.SERVICE_UNAVAILABLE,
                "知识库检索失败，请稍后重试",
                503,
            )


# ============ Agent Service ============


class AgentService:
    # 执行对话，调用 Agent 并处理错误转换
    @staticmethod
    async def chat(conversation_id: str, content: str, user_id: str = None) -> Message:
        try:
            from src.agents.base import AGENT_RECURSION_LIMIT, build_tool_agent
            from src.agents.deadline import AgentDeadline
            from src.agents.response_handler import (
                get_finish_reason,
                is_likely_truncated,
                maybe_append_continuation_hint,
            )
            from src.commands import execute_agent_command, get_agent_prompt_override
            from src.profile.service import HistoryService, MemoryService, ProfileService

            command = execute_agent_command(content, conversation_id)
            if command:
                reply = Message("assistant", command.reply)
                ConversationService.append_assistant_message(conversation_id, reply, user_id or "")
                return reply

            if user_id:
                try:
                    ProfileService.get_or_create(user_id)
                except Exception:
                    pass

            conversation = ConversationService.get(conversation_id)
            agent = (
                build_tool_agent(
                    system_prompt_override=get_agent_prompt_override(conversation_id, content)
                )
                if not conversation or conversation.mode != "knowledge"
                else None
            )
            config = {
                "configurable": {"thread_id": conversation_id},
                "recursion_limit": AGENT_RECURSION_LIMIT,
            }
            if user_id:
                config["configurable"]["user_id"] = user_id

            async with AgentDeadline():
                if conversation and conversation.mode == "knowledge":
                    from langchain_core.messages import HumanMessage
                    from src.rag.rag_agent import build_rag_agent

                    result = await build_rag_agent().ainvoke(
                        {
                            "messages": [HumanMessage(content=content)],
                            "context": [],
                            "should_retrieve": True,
                        }
                    )
                else:
                    result = await agent.ainvoke(
                        {
                            "messages": [{"role": "user", "content": content}],
                            "user_id": user_id,
                        },
                        config=config,
                    )

            reply_content = result["messages"][-1].content or "抱歉，我没有理解您的问题。"

            # 检测 LLM 输出截断
            last_ai_msg = result["messages"][-1]
            finish_reason = get_finish_reason(last_ai_msg)
            if is_likely_truncated(reply_content, finish_reason):
                reply_content = maybe_append_continuation_hint(reply_content, finish_reason)

            reply = Message("assistant", reply_content)
            ConversationService.append_assistant_message(conversation_id, reply, user_id or "")

            # 记录问答历史 + 提取新记忆
            if user_id:
                try:
                    HistoryService.record(user_id, conversation_id, content, reply_content)
                    MemoryService.extract_memories_from_conversation(
                        user_id, content, reply_content
                    )
                    ProfileService.update(user_id)
                except Exception:
                    pass

            return reply

        except TimeoutError:
            raise BusinessError(
                BusinessErrorCode.AGENT_TIMEOUT,
                "AI助手响应超时，请稍后重试。",
                504,
            )
        except BusinessError:
            raise
        except Exception as error:
            error_msg = str(error)
            if "rate limit" in error_msg.lower() or "429" in error_msg:
                raise BusinessError(
                    BusinessErrorCode.SERVICE_UNAVAILABLE,
                    "AI 服务暂时繁忙，请稍后重试",
                    503,
                )
            if "api key" in error_msg.lower():
                raise BusinessError(
                    BusinessErrorCode.SERVICE_UNAVAILABLE,
                    "AI 服务配置异常，请联系管理员",
                    503,
                )
            raise BusinessError(
                BusinessErrorCode.INTERNAL_ERROR,
                "处理请求时发生错误，请稍后重试",
                500,
            )

    # 流式对话，逐字返回 AI 回复和工具调用事件
    @staticmethod
    async def chat_stream(conversation_id: str, content: str, user_id: str = None):
        try:
            from src.agents.base import AGENT_RECURSION_LIMIT, build_tool_agent
            from src.agents.deadline import AgentDeadline
            from src.agents.response_handler import maybe_append_continuation_hint
            from src.commands import execute_agent_command, get_agent_prompt_override
            from src.profile.service import HistoryService, MemoryService, ProfileService

            command = execute_agent_command(content, conversation_id)
            if command:
                ConversationService.append_assistant_message(
                    conversation_id,
                    Message("assistant", command.reply),
                    user_id or "",
                )
                yield {"type": "text", "text": command.reply}
                return

            if user_id:
                try:
                    ProfileService.get_or_create(user_id)
                except Exception:
                    pass

            agent = build_tool_agent(
                system_prompt_override=get_agent_prompt_override(conversation_id, content)
            )
            config = {
                "configurable": {"thread_id": conversation_id},
                "recursion_limit": AGENT_RECURSION_LIMIT,
            }
            if user_id:
                config["configurable"]["user_id"] = user_id

            full_answer = ""
            async with AgentDeadline():
                async for event in agent.astream_events(
                    {
                        "messages": [{"role": "user", "content": content}],
                        "user_id": user_id,
                    },
                    config=config,
                    version="v2",
                ):
                    run_id = event.get("run_id", "")
                    if event["event"] == "on_tool_start":
                        yield {
                            "type": "tool",
                            "tool_name": event.get("name", "tool"),
                            "status": "started",
                            "run_id": run_id,
                        }
                    elif event["event"] == "on_tool_end":
                        yield {
                            "type": "tool",
                            "tool_name": event.get("name", "tool"),
                            "status": "completed",
                            "run_id": run_id,
                        }
                    elif event["event"] == "on_tool_error":
                        yield {
                            "type": "tool",
                            "tool_name": event.get("name", "tool"),
                            "status": "failed",
                            "run_id": run_id,
                        }
                    elif event["event"] == "on_chat_model_stream":
                        chunk = event["data"]["chunk"]
                        if isinstance(chunk.content, str) and chunk.content:
                            full_answer += chunk.content
                            yield {"type": "text", "text": chunk.content}

            if full_answer:
                final_answer = maybe_append_continuation_hint(full_answer)
                ConversationService.append_assistant_message(
                    conversation_id,
                    Message("assistant", final_answer),
                    user_id or "",
                )

            # Record Q&A + extract memories
            if user_id and full_answer:
                try:
                    HistoryService.record(user_id, conversation_id, content, full_answer)
                    MemoryService.extract_memories_from_conversation(user_id, content, full_answer)
                    ProfileService.update(user_id)
                except Exception:
                    pass

        except TimeoutError:
            if full_answer:
                partial = maybe_append_continuation_hint(full_answer)
                ConversationService.append_assistant_message(
                    conversation_id,
                    Message("assistant", partial),
                    user_id or "",
                )
                yield {"type": "text", "text": partial, "partial": True}
            else:
                raise BusinessError(
                    BusinessErrorCode.AGENT_TIMEOUT,
                    "AI助手响应超时，请稍后重试。",
                    504,
                )
        except BusinessError:
            raise
        except Exception as error:
            error_msg = str(error)
            if "rate limit" in error_msg.lower():
                raise BusinessError(
                    BusinessErrorCode.SERVICE_UNAVAILABLE,
                    "AI 服务暂时繁忙，请稍后重试",
                    503,
                )
            raise BusinessError(
                BusinessErrorCode.INTERNAL_ERROR,
                "处理请求时发生错误",
                500,
            )


__all__ = [
    "AgentService",
    "BusinessError",
    "BusinessErrorCode",
    "Capabilities",
    "Conversation",
    "ConversationService",
    "Document",
    "KnowledgeService",
    "Message",
]
