"""
Service Layer — 业务逻辑编排

职责：
1. 编排 Agent / RAG / 工具的调用
2. 将内部返回转换为前端友好的格式
3. 错误转换（内部错误 → 业务错误码）
4. 与 API 层解耦，前端看不到内部实现
"""

from datetime import datetime
from enum import Enum
from typing import Optional

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


class BusinessError(Exception):
    def __init__(self, code: BusinessErrorCode, message: str, status_code: int = 500):
        self.code = code
        self.message = message
        self.status_code = status_code
        super().__init__(message)

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
    @staticmethod
    def create(title: str, mode: str = "chat") -> Conversation:
        conv = Conversation(title, mode)
        _conversations[conv.id] = conv
        return conv

    @staticmethod
    def get(conv_id: str) -> Conversation | None:
        return _conversations.get(conv_id)

    @staticmethod
    def list() -> list[dict]:
        return sorted(
            [c.to_dict() for c in _conversations.values()],
            key=lambda c: c["created_at"],
            reverse=True,
        )

    @staticmethod
    def delete(conv_id: str) -> bool:
        if conv_id in _conversations:
            del _conversations[conv_id]
            return True
        return False

    @staticmethod
    def append_user_message(conv_id: str, content: str) -> Message:
        conv = _conversations.get(conv_id)
        if not conv:
            raise BusinessError(BusinessErrorCode.NOT_FOUND, "Conversation not found", 404)
        conv.message_count += 1
        return Message("user", content)


# ============ Knowledge Service ============

_documents: dict[str, Document] = {}


class KnowledgeService:
    @staticmethod
    async def upload_document(buffer: bytes, filename: str, category: str = None) -> Document:
        """上传并索引文档"""
        try:
            from src.rag.embedder import Embedder
            from src.rag.loader import Document
            from src.rag.splitter import TextSplitter
            from src.rag.vector_store import VectorStore

            # 加载文档
            doc = Document.from_bytes(buffer, filename)

            # 切分
            splitter = TextSplitter()
            chunks = splitter.split(doc.content, filename, doc.metadata["source"])

            # 向量化并存储
            vector_store = VectorStore(
                url="http://localhost:6333",
                collection_name="documents",
            )

            chunk_dicts = [
                {
                    "id": f"chunk_{i}",
                    "content": chunk.text,
                    "metadata": chunk.metadata,
                }
                for i, chunk in enumerate(chunks)
            ]

            await vector_store.add_documents(chunk_dicts)

            document = Document(
                name=filename,
                size=len(buffer),
                chunks=len(chunks),
                category=category,
            )
            _documents[document.id] = document
            return document

        except Exception as e:
            raise BusinessError(
                BusinessErrorCode.INTERNAL_ERROR,
                f"文档上传失败: {e!s}",
                500,
            )

    @staticmethod
    def list_documents() -> list[dict]:
        return sorted(
            [d.to_dict() for d in _documents.values()],
            key=lambda d: d["created_at"],
            reverse=True,
        )

    @staticmethod
    def get_document(doc_id: str) -> Document | None:
        return _documents.get(doc_id)

    @staticmethod
    def delete_document(doc_id: str) -> bool:
        if doc_id in _documents:
            del _documents[doc_id]
            return True
        return False

    @staticmethod
    async def reindex_document(doc_id: str) -> Document:
        doc = _documents.get(doc_id)
        if not doc:
            raise BusinessError(BusinessErrorCode.NOT_FOUND, "Document not found", 404)
        doc.status = "indexed"
        return doc

    @staticmethod
    async def search(query: str, top_k: int = 5) -> list[dict]:
        """知识检索"""
        try:
            from src.rag.retriever import Retriever

            retriever = Retriever(
                qdrant_url="http://localhost:6333",
                collection_name="documents",
                top_k=top_k,
            )

            results = await retriever.retrieve(query)
            return results
        except Exception:
            raise BusinessError(
                BusinessErrorCode.SERVICE_UNAVAILABLE,
                "知识库检索失败，请稍后重试",
                503,
            )


# ============ Agent Service ============


class AgentService:
    @staticmethod
    async def chat(conversation_id: str, content: str, user_id: str = None) -> Message:
        try:
            from src.agents.base import AGENT_RECURSION_LIMIT, build_tool_agent
            from src.profile.service import HistoryService, MemoryService, ProfileService

            if user_id:
                try:
                    ProfileService.get_or_create(user_id)
                except Exception:
                    pass

            agent = build_tool_agent()
            config = {
                "configurable": {"thread_id": conversation_id},
                "recursion_limit": AGENT_RECURSION_LIMIT,
            }
            if user_id:
                config["configurable"]["user_id"] = user_id

            result = await agent.ainvoke(
                {"messages": [{"role": "user", "content": content}], "user_id": user_id},
                config=config,
            )

            reply_content = result["messages"][-1].content or "抱歉，我没有理解您的问题。"
            reply = Message("assistant", reply_content)

            # 记录问答历史 + 提取新记忆
            if user_id:
                try:
                    HistoryService.record(user_id, conversation_id, content, reply_content)
                    MemoryService.extract_memories_from_conversation(user_id, content, reply_content)
                    ProfileService.update(user_id)
                except Exception:
                    pass

            return reply

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

    @staticmethod
    async def chat_stream(conversation_id: str, content: str, user_id: str = None):
        try:
            from src.agents.base import AGENT_RECURSION_LIMIT, build_tool_agent
            from src.profile.service import HistoryService, MemoryService, ProfileService

            if user_id:
                try:
                    ProfileService.get_or_create(user_id)
                except Exception:
                    pass

            agent = build_tool_agent()
            config = {
                "configurable": {"thread_id": conversation_id},
                "recursion_limit": AGENT_RECURSION_LIMIT,
            }
            if user_id:
                config["configurable"]["user_id"] = user_id

            full_answer = ""
            async for event in agent.astream_events(
                {"messages": [{"role": "user", "content": content}], "user_id": user_id},
                config=config,
                version="v2",
            ):
                if event["event"] == "on_chat_model_stream":
                    chunk = event["data"]["chunk"]
                    if chunk.content:
                        full_answer += chunk.content
                        yield chunk.content

            # Record Q&A + extract memories
            if user_id and full_answer:
                try:
                    HistoryService.record(user_id, conversation_id, content, full_answer)
                    MemoryService.extract_memories_from_conversation(user_id, content, full_answer)
                    ProfileService.update(user_id)
                except Exception:
                    pass

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
