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

from src.tools.runtime.executor import create_tool_call_context, tool_call_scope
from src.config.settings import settings

logger = logging.getLogger(__name__)

STREAM_FALLBACK_CHUNK_SIZE = 8
STREAM_FALLBACK_INTERVAL_SECONDS = 0.018
_background_tasks: set[asyncio.Task] = set()
_background_chains: dict[str, asyncio.Task] = {}
_background_semaphore: asyncio.Semaphore | None = None
_background_semaphore_loop = None


# 获取当前事件循环的后台任务并发闸门，避免持久化任务耗尽线程池。
def _get_background_semaphore() -> asyncio.Semaphore:
    global _background_semaphore, _background_semaphore_loop
    loop = asyncio.get_running_loop()
    if _background_semaphore is None or _background_semaphore_loop is not loop:
        _background_semaphore = asyncio.Semaphore(settings.background_task_concurrency)
        _background_semaphore_loop = loop
    return _background_semaphore


# 将同步持久化工作放入线程后台执行，避免阻塞 SSE 事件循环。
def schedule_background_task(label: str, callback, *args) -> None:
    if len(_background_tasks) >= settings.background_task_queue_max:
        logger.warning("Background task queue is full; skipped label=%s", label)
        return
    previous = _background_chains.get(label)

    # 串行执行同一会话的后台写入，避免快速连续请求乱序落库。
    async def runner() -> None:
        try:
            if previous:
                await asyncio.shield(previous)
        except Exception:
            pass
        try:
            async with _get_background_semaphore():
                await asyncio.to_thread(callback, *args)
        except Exception:
            logger.exception("Background task failed | label=%s", label)

    task = asyncio.create_task(runner(), name=f"agent-background-{label}")
    _background_tasks.add(task)
    _background_chains[label] = task

    # 任务完成后清理集合和对应会话的串行链。
    def cleanup(done_task: asyncio.Task) -> None:
        _background_tasks.discard(done_task)
        if _background_chains.get(label) is done_task:
            _background_chains.pop(label, None)

    task.add_done_callback(cleanup)


# 等待已排队的后台任务，供优雅停机和集成测试使用。
async def flush_background_tasks() -> None:
    while _background_tasks:
        await asyncio.gather(*tuple(_background_tasks), return_exceptions=True)


# 从 LangChain 消息块中提取可展示的文本增量。
def get_stream_text(chunk) -> str:
    content = chunk.get("content", chunk) if isinstance(chunk, dict) else getattr(chunk, "content", chunk)
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    return "".join(
        part if isinstance(part, str) else str(part.get("text", ""))
        for part in content
        if isinstance(part, (str, dict))
    )


# 过滤 LangGraph/LangChain 事件中的结束哨兵和 XML 工具调用文本。
def normalize_agent_output_text(text: str) -> str:
    normalized = strip_xml_tool_stream(text)
    return "" if normalized.strip() == "__end__" else normalized


# 从 LangChain 链路结束事件中提取最终 AI 消息，兼容 output/output.messages 两种结构。
def extract_agent_output_text(output) -> str:
    if isinstance(output, str):
        return normalize_agent_output_text(output)
    if not isinstance(output, dict):
        return ""
    nested = output.get("output")
    if isinstance(nested, str):
        return normalize_agent_output_text(nested)
    if isinstance(nested, dict):
        text = extract_agent_output_text(nested)
        if text:
            return text
    messages = output.get("messages")
    if isinstance(messages, list):
        for message in reversed(messages):
            if isinstance(message, dict):
                message_type = message.get("type") or message.get("role", "")
            else:
                get_type = getattr(message, "_get_type", None)
                message_type = get_type() if callable(get_type) else getattr(message, "type", "")
            if message_type not in {"ai", "assistant"}:
                continue
            text = get_stream_text(message)
            if text.strip():
                return normalize_agent_output_text(text)
    output_type = output.get("type") or output.get("role", "")
    return (
        normalize_agent_output_text(get_stream_text(output))
        if output_type in {"ai", "assistant"}
        else ""
    )


XML_TOOL_STREAM_MARKERS = ("<invoke", "<function=")


# 从模型流中提取安全可展示文本，并丢弃完整的 XML 工具调用块。
def drain_xml_tool_stream(buffer: str, final: bool = False) -> tuple[str, str]:
    """Return visible text and the incomplete XML candidate kept for the next chunk."""
    visible = ""
    cursor = 0
    while cursor < len(buffer):
        lower = buffer.lower()
        marker_index = -1
        for marker in XML_TOOL_STREAM_MARKERS:
            index = lower.find(marker, cursor)
            if index != -1 and (marker_index == -1 or index < marker_index):
                marker_index = index
        if marker_index == -1:
            tail = buffer[cursor:]
            if final:
                return visible + tail, ""
            hold_length = 0
            for marker in XML_TOOL_STREAM_MARKERS:
                for length in range(1, min(len(marker) - 1, len(tail)) + 1):
                    if marker.startswith(tail[-length:].lower()):
                        hold_length = max(hold_length, length)
            return visible + tail[:-hold_length] if hold_length else visible + tail, (
                tail[-hold_length:] if hold_length else ""
            )
        visible += buffer[cursor:marker_index]
        rest = lower[marker_index:]
        close = "</invoke>" if rest.startswith("<invoke") else "</function>"
        close_index = rest.find(close)
        if close_index == -1:
            return visible, buffer[marker_index:]
        cursor = marker_index + close_index + len(close)
    return visible, ""


# 清理非流式回退路径中的 XML 工具调用文本。
def strip_xml_tool_stream(text: str) -> str:
    """Remove complete XML tool calls from a complete model response."""
    return drain_xml_tool_stream(text, final=True)[0].strip()


# 在回答生成后异步保存会话、历史和记忆，保证失败不影响已发送内容。
def schedule_answer_persistence(
    conversation_id: str,
    content: str,
    answer: str,
    user_id: str = "",
) -> None:
    def persist() -> None:
        ConversationService.append_assistant_message(
            conversation_id,
            Message("assistant", answer),
            user_id,
        )
        if user_id:
            from src.profile.service import HistoryService, MemoryService, ProfileService

            HistoryService.record(user_id, conversation_id, content, answer)
            MemoryService.extract_memories_from_conversation(user_id, content, answer)
            ProfileService.update(user_id)

    schedule_background_task(f"answer:{conversation_id}", persist)


# 将模型完整回答按可见字符拆成平滑的 SSE 分片，避免依赖厂商工具流格式
async def stream_text_chunks(text: str):
    for index in range(0, len(text), STREAM_FALLBACK_CHUNK_SIZE):
        yield text[index : index + STREAM_FALLBACK_CHUNK_SIZE]
        if index + STREAM_FALLBACK_CHUNK_SIZE < len(text):
            await asyncio.sleep(STREAM_FALLBACK_INTERVAL_SECONDS)


# 从会话记录恢复大公鸡模式，避免进程内状态丢失后人设失效
def restore_command_state_from_conversation(conversation_id: str) -> None:
    from src.commands import restore_agent_command_state

    user_messages = [
        str(message["content"])
        for message in ConversationService.get_messages(conversation_id)
        if message.get("role") == "user"
    ]
    restore_agent_command_state(conversation_id, user_messages)


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
    # 初始化当前对象
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
    # 初始化会话领域对象并保留持久化标识
    def __init__(
        self,
        title: str,
        mode: str = "chat",
        conversation_id: str | None = None,
        user_id: str = "anonymous",
        created_at: str | None = None,
    ):
        self.id = conversation_id or f"conv_{datetime.now().strftime('%Y%m%d%H%M%S%f')}"
        self.title = title
        self.mode = mode
        self.user_id = user_id or "anonymous"
        self.created_at = created_at or datetime.now().isoformat()
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
    # 初始化消息领域对象并支持从持久化记录恢复
    def __init__(
        self,
        role: str,
        content: str,
        message_id: str | None = None,
        created_at: str | None = None,
    ):
        self.id = message_id or f"msg_{datetime.now().strftime('%Y%m%d%H%M%S%f')}"
        self.role = role
        self.content = content
        self.created_at = created_at or datetime.now().isoformat()

    # 将消息对象序列化为字典
    def to_dict(self):
        return {
            "id": self.id,
            "role": self.role,
            "content": self.content,
            "created_at": self.created_at,
        }


class Document:
    # 初始化文档领域对象并支持从 D1 记录恢复
    def __init__(
        self,
        name: str,
        size: int,
        chunks: int = 0,
        category: str = None,
        document_id: str | None = None,
        status: str = "indexed",
        created_at: str | None = None,
    ):
        self.id = document_id or f"doc_{datetime.now().strftime('%Y%m%d%H%M%S%f')}"
        self.name = name
        self.size = size
        self.status = status
        self.chunks = chunks
        self.category = category
        self.created_at = created_at or datetime.now().isoformat()

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
    # 获取 get 对应的数据
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
DEFAULT_CONVERSATION_USER_ID = "anonymous"


class ConversationService:
    # 创建新会话并注册到内存存储，同时持久化到 D1
    @staticmethod
    # 创建或注册 create 所需的数据
    def create(
        title: str,
        mode: str = "chat",
        user_id: str = DEFAULT_CONVERSATION_USER_ID,
    ) -> Conversation:
        normalized_user_id = user_id or DEFAULT_CONVERSATION_USER_ID
        conv = Conversation(title, mode, user_id=normalized_user_id)
        _conversations[conv.id] = conv

        try:
            from src.repositories import get_repositories

            get_repositories().create_conversation(
                normalized_user_id,
                title,
                mode,
                conv.id,
            )
        except Exception as exc:
            _conversations.pop(conv.id, None)
            raise BusinessError(
                BusinessErrorCode.SERVICE_UNAVAILABLE,
                f"会话持久化失败: {exc}",
                503,
            ) from exc

        return conv

    @staticmethod
    # 确保会话存在于 D1，不存在则创建；同时注册到内存
    def ensure(
        conv_id: str,
        user_id: str = DEFAULT_CONVERSATION_USER_ID,
        title: str = "New Chat",
        mode: str = "chat",
    ) -> Conversation:
        normalized_user_id = user_id or DEFAULT_CONVERSATION_USER_ID
        cached = _conversations.get(conv_id)
        if cached and cached.user_id != normalized_user_id:
            raise BusinessError(
                BusinessErrorCode.FORBIDDEN,
                "无权访问该会话",
                403,
            )
        if cached:
            return cached

        # 先检查 D1
        existing = None
        try:
            from src.repositories import get_repositories

            existing = get_repositories().get_conversation(conv_id)
            if existing and existing.get("user_id") != normalized_user_id:
                raise BusinessError(
                    BusinessErrorCode.FORBIDDEN,
                    "无权访问该会话",
                    403,
                )
            if existing:
                _conversations[conv_id] = Conversation(
                    title=existing.get("title", ""),
                    mode=existing.get("mode", "chat"),
                    conversation_id=existing["id"],
                    user_id=existing.get("user_id", DEFAULT_CONVERSATION_USER_ID),
                    created_at=existing.get("created_at"),
                )
            else:
                get_repositories().create_conversation(
                    normalized_user_id,
                    title,
                    mode,
                    conv_id,
                )
        except BusinessError:
            raise
        except Exception as exc:
            raise BusinessError(
                BusinessErrorCode.SERVICE_UNAVAILABLE,
                f"会话持久化失败: {exc}",
                503,
            ) from exc

        # 注册到内存
        if not existing and conv_id not in _conversations:
            conv = Conversation(title, mode, conv_id, normalized_user_id)
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
                conversation_id=data["id"],
                user_id=data.get("user_id", DEFAULT_CONVERSATION_USER_ID),
                created_at=data.get("created_at"),
            )
            _conversations[conv_id] = conv
            return conv
        except Exception as exc:
            logger.warning("[service] D1 get conversation %s failed: %s", conv_id, exc)
            return None

    @staticmethod
    # 列出所有会话，D1 为权威数据源
    def list(user_id: str | None = None) -> list[dict]:
        normalized_user_id = user_id or DEFAULT_CONVERSATION_USER_ID
        try:
            from src.repositories import get_repositories
            repos = get_repositories()

            all_convs: dict[str, dict] = {}

            items = repos.list_conversations(normalized_user_id, 100, 0)
            for item in items:
                all_convs[item["id"]] = {
                    "id": item["id"],
                    "title": item.get("title", ""),
                    "mode": item.get("mode", "chat"),
                    "created_at": item.get("created_at", ""),
                    "message_count": 0,
                }

            # 只合并当前用户的内存会话
            for c in _conversations.values():
                if c.user_id == normalized_user_id and c.id not in all_convs:
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
                [
                    c.to_dict()
                    for c in _conversations.values()
                    if c.user_id == normalized_user_id
                ],
                key=lambda c: c["created_at"],
                reverse=True,
            )

    @staticmethod
    # 删除会话及其关联的消息和命令状态，同时从 D1 删除
    def delete(conv_id: str) -> bool:
        from src.commands import clear_agent_command_state
        from src.repositories import get_repositories

        deleted = get_repositories().delete_conversation(conv_id)
        if not deleted:
            return False
        clear_agent_command_state(conv_id)
        _conversations.pop(conv_id, None)
        return True

    @staticmethod
    # 向会话追加一条用户消息，同时持久化到 D1
    def append_user_message(conv_id: str, content: str, user_id: str = "") -> Message:
        conv = _conversations.get(conv_id)
        if not conv:
            raise BusinessError(BusinessErrorCode.NOT_FOUND, "Conversation not found", 404)
        ConversationService.get_messages(conv_id)
        conv.message_count += 1
        message = Message("user", content)
        sequence_number = len(conv.messages)
        conv.messages.append(message)

        from src.repositories import get_repositories

        get_repositories().create_message_batch(
            conv_id,
            user_id or conv.user_id,
            [{
                "id": message.id,
                "sequence_no": sequence_number,
                "role": "user",
                "content": content,
                "created_at": message.created_at,
            }],
        )

        return message

    @staticmethod
    # 向会话追加一条助手消息，同时持久化到 D1
    def append_assistant_message(conv_id: str, message: Message, user_id: str = "") -> None:
        conv = _conversations.get(conv_id)
        if not conv:
            raise BusinessError(BusinessErrorCode.NOT_FOUND, "Conversation not found", 404)
        ConversationService.get_messages(conv_id)
        sequence_number = len(conv.messages)
        conv.messages.append(message)

        from src.repositories import get_repositories

        get_repositories().create_message_batch(
            conv_id,
            user_id or conv.user_id,
            [{
                "id": message.id,
                "sequence_no": sequence_number,
                "role": "assistant",
                "content": message.content,
                "created_at": message.created_at,
            }],
        )

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
                conv.messages = [
                    Message(
                        m["role"],
                        m["content_json"],
                        message_id=m["id"],
                        created_at=m["created_at"],
                    )
                    for m in messages_data
                ]
                conv.message_count = sum(m.role == "user" for m in conv.messages)

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
        from src.repositories import get_repositories

        get_repositories().clear_messages(conv_id)


# ============ Knowledge Service ============

_documents: dict[str, Document] = {}
_document_contents: dict[str, tuple[bytes, str]] = {}
_document_chunks: dict[str, list[str]] = {}
_local_search_entries: dict[str, dict] = {}
_local_search_postings: dict[str, set[str]] = {}
_local_document_search_keys: dict[str, set[str]] = {}


# 将本地文档切块并返回可供检索的纯文本块。
def _split_local_document(buffer: bytes, filename: str) -> list[str]:
    from src.rag.loader import Document as RagDocument
    from src.rag.splitter import TextSplitter

    loaded = RagDocument.from_bytes(buffer, filename)
    chunks = TextSplitter().split(
        loaded.content,
        filename,
        str(loaded.metadata.get("source", f"upload://{filename}")),
    )
    return [chunk.text for chunk in chunks]


# 移除单个本地文档的倒排检索项，避免删除或重建后残留。
def _remove_local_document_search_index(document_id: str) -> None:
    keys = _local_document_search_keys.pop(document_id, set())
    for key in keys:
        entry = _local_search_entries.pop(key, None)
        if not entry:
            continue
        for character in entry["characters"]:
            postings = _local_search_postings.get(character)
            if postings is None:
                continue
            postings.discard(key)
            if not postings:
                _local_search_postings.pop(character, None)


# 用最新文档块重建字符倒排索引，减少检索时的无关块扫描。
def _replace_local_document_search_index(document_id: str, chunks: list[str]) -> None:
    _remove_local_document_search_index(document_id)
    keys: set[str] = set()
    for chunk_index, content in enumerate(chunks):
        normalized_content = content.lower()
        characters = {character for character in normalized_content if not character.isspace()}
        key = f"{document_id}:{chunk_index}"
        _local_search_entries[key] = {
            "document_id": document_id,
            "chunk_index": chunk_index,
            "content": content,
            "normalized_content": normalized_content,
            "characters": characters,
        }
        keys.add(key)
        for character in characters:
            _local_search_postings.setdefault(character, set()).add(key)
    _local_document_search_keys[document_id] = keys


# 在关闭 Cloudflare Memory 时通过倒排索引执行有界 Top-K 词法检索。
def _search_local_documents(query: str, top_k: int) -> list[dict]:
    normalized_query = query.strip().lower()
    query_characters = {character for character in normalized_query if not character.isspace()}
    if not normalized_query or not query_characters:
        return []

    candidate_keys: set[str] = set()
    for character in query_characters:
        candidate_keys.update(_local_search_postings.get(character, set()))

    results: list[dict] = []
    for key in candidate_keys:
        entry = _local_search_entries.get(key)
        document = _documents.get(entry["document_id"]) if entry else None
        if not entry or not document:
            continue
        exact_match = normalized_query in entry["normalized_content"]
        matched_characters = (
            len(query_characters)
            if exact_match
            else sum(character in entry["characters"] for character in query_characters)
        )
        score = 1 if exact_match else matched_characters / len(query_characters)
        if score <= 0:
            continue
        result = {
            "document_id": document.id,
            "document_name": document.name,
            "content": entry["content"][:2000],
            "score": score,
            "chunk_index": entry["chunk_index"],
        }
        if len(results) < top_k:
            results.append(result)
            continue
        lowest_index = min(range(len(results)), key=lambda index: results[index]["score"])
        if score > results[lowest_index]["score"]:
            results[lowest_index] = result
    return sorted(results, key=lambda item: item["score"], reverse=True)


class KnowledgeService:
    """文档知识库服务 — 通过 Cloudflare Service Gateway"""

    @staticmethod
    # 创建或注册 upload document 所需的数据
    async def upload_document(buffer: bytes, filename: str, category: str = None) -> Document:
        """上传并索引文档"""
        try:
            chunks = _split_local_document(buffer, filename)
            if not settings.memory_enabled:
                document = Document(
                    name=filename,
                    size=len(buffer),
                    chunks=len(chunks),
                    category=category,
                )
                _documents[document.id] = document
                _document_contents[document.id] = (buffer, filename)
                _document_chunks[document.id] = chunks
                _replace_local_document_search_index(document.id, chunks)
                return document

            import base64

            from src.clients.memory_gateway import CloudflareMemoryClient

            client = CloudflareMemoryClient()
            # 使用默认用户上传（共享知识库）
            result = await client.upload_document(
                user_id="default",
                filename=filename,
                content=base64.b64encode(buffer).decode(),
                category=category or "general",
            )

            document = Document(
                name=filename,
                size=len(buffer),
                chunks=result.get("chunk_count", 0),
                category=category,
                document_id=result["id"],
                status=result.get("status", "indexed"),
                created_at=result.get("created_at", datetime.now().isoformat()),
            )

            _documents[document.id] = document
            _document_contents[document.id] = (buffer, filename)
            _document_chunks[document.id] = chunks
            _replace_local_document_search_index(document.id, chunks)
            return document

        except Exception as e:
            raise BusinessError(
                BusinessErrorCode.INTERNAL_ERROR,
                f"文档上传失败: {e!s}",
                500,
            )

    @staticmethod
    # 获取 list documents 对应的数据
    async def list_documents() -> list[dict]:
        """列出所有已索引文档，D1 为权威数据源"""
        if not settings.memory_enabled:
            return sorted(
                [document.to_dict() for document in _documents.values()],
                key=lambda document: document["created_at"],
                reverse=True,
            )
        try:
            from src.clients.memory_gateway import CloudflareMemoryClient
            client = CloudflareMemoryClient()
            result = await client.list_documents("default", limit=100)
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
                        document_id=d["id"],
                        status=d["status"],
                        created_at=d["created_at"],
                    )
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
    # 获取 get document 对应的数据
    async def get_document(doc_id: str) -> Document | None:
        """获取指定文档详情，内存未命中时从 D1 加载"""
        cached = _documents.get(doc_id)
        if cached:
            return cached
        if not settings.memory_enabled:
            return None

        # D1 回退
        try:
            from src.clients.memory_gateway import CloudflareMemoryClient
            client = CloudflareMemoryClient()
            data = await client.get_document(doc_id)
            if not data:
                return None
            doc_data = data.get("document", {})
            doc = Document(
                name=doc_data.get("name", ""),
                size=doc_data.get("size", 0),
                chunks=doc_data.get("chunk_count", 0),
                category=doc_data.get("category"),
                document_id=doc_data["id"],
                status=doc_data.get("status", "indexed"),
                created_at=doc_data.get("created_at", datetime.now().isoformat()),
            )
            _documents[doc_id] = doc

            # 缓存原始内容用于 reindex
            content_text = doc_data.get("content_text", "")
            if content_text:
                _document_contents[doc_id] = (content_text.encode("utf-8"), doc.name)

            return doc
        except Exception as exc:
            raise BusinessError(
                BusinessErrorCode.INTERNAL_ERROR,
                f"文档读取失败: {exc!s}",
                500,
            ) from exc

    @staticmethod
    # 删除或清理 delete document 对应的数据
    async def delete_document(doc_id: str) -> bool:
        """删除指定文档及其向量索引"""
        if not settings.memory_enabled:
            _remove_local_document_search_index(doc_id)
            deleted = _documents.pop(doc_id, None) is not None
            _document_contents.pop(doc_id, None)
            _document_chunks.pop(doc_id, None)
            return deleted
        try:
            from src.clients.memory_gateway import CloudflareMemoryClient

            client = CloudflareMemoryClient()
            deleted = await client.delete_document(doc_id)
            if not deleted:
                return False
        except Exception as exc:
            raise BusinessError(
                BusinessErrorCode.INTERNAL_ERROR,
                f"文档删除失败: {exc!s}",
                500,
            ) from exc

        _documents.pop(doc_id, None)
        _document_contents.pop(doc_id, None)
        _document_chunks.pop(doc_id, None)
        _remove_local_document_search_index(doc_id)
        return True

    @staticmethod
    # 执行 reindex document 对应的业务逻辑
    async def reindex_document(doc_id: str) -> Document:
        """重新索引指定文档，内存无内容时从 D1 加载"""
        if not settings.memory_enabled:
            document = _documents.get(doc_id)
            stored = _document_contents.get(doc_id)
            if not document or not stored:
                raise BusinessError(BusinessErrorCode.NOT_FOUND, "Document not found", 404)
            chunks = _split_local_document(*stored)
            document.chunks = len(chunks)
            document.status = "indexed"
            _document_chunks[doc_id] = chunks
            _replace_local_document_search_index(doc_id, chunks)
            return document
        try:
            from src.clients.memory_gateway import CloudflareMemoryClient, MemoryGatewayError

            client = CloudflareMemoryClient()
            await client.reindex_document(doc_id)
            _documents.pop(doc_id, None)
            document = await KnowledgeService.get_document(doc_id)
            if not document:
                raise BusinessError(BusinessErrorCode.NOT_FOUND, "Document not found", 404)
            return document
        except BusinessError:
            raise
        except MemoryGatewayError as exc:
            if exc.code == "DOCUMENT_NOT_FOUND":
                raise BusinessError(
                    BusinessErrorCode.NOT_FOUND,
                    "Document not found",
                    404,
                ) from exc
            raise BusinessError(
                BusinessErrorCode.INTERNAL_ERROR,
                f"文档重新索引失败: {exc!s}",
                500,
            ) from exc

    @staticmethod
    # 查询 search 对应的结果
    async def search(query: str, top_k: int = 5) -> list[dict]:
        """知识检索"""
        if not settings.memory_enabled:
            return _search_local_documents(query, top_k)
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
                    "chunk_index": r.get("chunk_index"),
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
    # 执行 chat 对应的业务逻辑
    async def chat(conversation_id: str, content: str, user_id: str = None) -> Message:
        try:
            from src.agents.graph_agents import (
                AGENT_RECURSION_LIMIT,
                build_chat_agent,
                build_tool_agent,
                get_fast_path_answer,
                is_direct_chat_message,
            )
            from src.agents.deadline import AgentDeadline
            from src.agents.response_handler import (
                get_finish_reason,
                is_likely_truncated,
                maybe_append_continuation_hint,
            )
            from src.commands import (
                execute_agent_command,
                get_agent_prompt_override,
                get_dark_mode_thread_id,
            )
            from src.profile.service import HistoryService, MemoryService, ProfileService

            command = execute_agent_command(content, conversation_id)
            if command:
                reply = Message("assistant", command.reply)
                ConversationService.append_assistant_message(conversation_id, reply, user_id or "")
                return reply

            fast_answer = get_fast_path_answer(content)
            if fast_answer:
                schedule_answer_persistence(conversation_id, content, fast_answer, user_id or "")
                return Message("assistant", fast_answer)


            conversation = ConversationService.get(conversation_id)
            restore_command_state_from_conversation(conversation_id)
            prompt_override = get_agent_prompt_override(conversation_id, content)
            agent_thread_id = (
                get_dark_mode_thread_id(conversation_id)
                if prompt_override
                else conversation_id
            )
            agent = (
                (
                    build_chat_agent()
                    if is_direct_chat_message(content)
                    else build_tool_agent(system_prompt_override=prompt_override)
                )
                if not conversation or conversation.mode != "knowledge"
                else None
            )
            config = {
                "configurable": {"thread_id": agent_thread_id},
                "recursion_limit": AGENT_RECURSION_LIMIT,
            }
            if user_id:
                config["configurable"]["user_id"] = user_id

            runtime_context = create_tool_call_context(user_id or "", conversation_id)
            deadline_args = (
                (
                    settings.agent_deadline_ms,
                    settings.agent_deadline_with_tools_ms,
                )
                if not conversation or conversation.mode != "knowledge"
                else ()
            )
            with tool_call_scope(runtime_context):
                async with AgentDeadline(*deadline_args):
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

            reply_content = extract_agent_output_text(result) or "抱歉，我没有理解您的问题。"

            # 检测 LLM 输出截断
            last_ai_msg = next(
                (
                    message
                    for message in reversed(result.get("messages", []))
                    if getattr(message, "type", "") == "ai"
                ),
                result["messages"][-1],
            )
            finish_reason = get_finish_reason(last_ai_msg)
            if is_likely_truncated(reply_content, finish_reason):
                reply_content = maybe_append_continuation_hint(reply_content, finish_reason)

            reply = Message("assistant", reply_content)
            schedule_answer_persistence(conversation_id, content, reply_content, user_id or "")

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
            logger.exception(
                "Agent chat failed | conversation_id=%s user_id=%s content=%r",
                conversation_id,
                user_id,
                content,
            )
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
    # 执行 chat stream 对应的业务逻辑
    async def chat_stream(conversation_id: str, content: str, user_id: str = None):
        full_answer = ""
        stream_text_buffer = ""
        emitted_text = False
        observed_tool_event = False
        react_summary = None
        try:
            from src.agents.graph_agents import (
                AGENT_RECURSION_LIMIT,
                build_chat_agent,
                build_tool_agent,
                get_fast_path_answer,
                is_direct_chat_message,
            )
            from src.agents.deadline import AgentDeadline
            from src.agents.response_handler import maybe_append_continuation_hint
            from src.commands import (
                execute_agent_command,
                get_agent_prompt_override,
                get_dark_mode_thread_id,
            )
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

            fast_answer = get_fast_path_answer(content)
            if fast_answer:
                schedule_answer_persistence(conversation_id, content, fast_answer, user_id or "")
                yield {"type": "text", "text": fast_answer}
                return


            conversation = ConversationService.get(conversation_id)
            restore_command_state_from_conversation(conversation_id)
            prompt_override = get_agent_prompt_override(conversation_id, content)
            agent_thread_id = (
                get_dark_mode_thread_id(conversation_id)
                if prompt_override
                else conversation_id
            )
            runtime_context = create_tool_call_context(user_id or "", conversation_id)
            if conversation and conversation.mode == "knowledge":
                from langchain_core.messages import HumanMessage
                from src.rag.rag_agent import build_rag_agent

                rag_agent = build_rag_agent()
                with tool_call_scope(runtime_context):
                    async with AgentDeadline():
                        rag_input = {
                            "messages": [HumanMessage(content=content)],
                            "context": [],
                            "should_retrieve": True,
                        }
                        rag_stream_api = hasattr(rag_agent, "astream_events")
                        if rag_stream_api:
                            async for event in rag_agent.astream_events(
                                rag_input, version="v2"
                            ):
                                if event.get("event") == "on_chat_model_stream":
                                    delta = get_stream_text(
                                        event.get("data", {}).get("chunk")
                                    )
                                    if delta:
                                        full_answer += delta
                                        emitted_text = True
                                        yield {"type": "text", "text": delta}
                                elif (
                                    event.get("event") in {"on_chain_end", "on_chat_model_end"}
                                    and not full_answer.strip()
                                ):
                                    output = event.get("data", {}).get("output", {})
                                    full_answer = extract_agent_output_text(output)
                        else:
                            result = await rag_agent.ainvoke(rag_input)
                            full_answer = result["messages"][-1].content
                if not full_answer.strip():
                    full_answer = "抱歉，我没有理解您的问题。"
                raw_answer = full_answer
                if not emitted_text:
                    if rag_stream_api:
                        async for text in stream_text_chunks(raw_answer):
                            emitted_text = True
                            yield {"type": "text", "text": text}
                    else:
                        yield {"type": "text", "text": raw_answer}
                final_answer = maybe_append_continuation_hint(raw_answer)
                if final_answer != raw_answer:
                    yield {"type": "text", "text": final_answer[len(raw_answer):]}
                schedule_answer_persistence(
                    conversation_id, content, final_answer, user_id or ""
                )
                return

            agent = (
                build_chat_agent()
                if is_direct_chat_message(content)
                else build_tool_agent(system_prompt_override=prompt_override)
            )
            config = {
                "configurable": {"thread_id": agent_thread_id},
                "recursion_limit": AGENT_RECURSION_LIMIT,
            }
            if user_id:
                config["configurable"]["user_id"] = user_id

            with tool_call_scope(runtime_context):
                async with AgentDeadline(
                    settings.agent_deadline_ms,
                    settings.agent_deadline_with_tools_ms,
                ):
                    if hasattr(agent, "astream_events"):
                        async for event in agent.astream_events(
                            {
                                "messages": [{"role": "user", "content": content}],
                                "user_id": user_id,
                            },
                            config=config,
                            version="v2",
                        ):
                            event_name = event.get("event")
                            if event_name == "on_chat_model_stream":
                                delta = get_stream_text(event.get("data", {}).get("chunk"))
                                if delta:
                                    stream_text_buffer += delta
                                    visible, stream_text_buffer = drain_xml_tool_stream(stream_text_buffer)
                                    if visible.strip() or emitted_text:
                                        full_answer += visible
                                        emitted_text = True
                                        yield {"type": "text", "text": visible}
                            elif event_name == "on_tool_start":
                                observed_tool_event = True
                                yield {
                                    "type": "tool",
                                    "tool_name": event.get("name") or "tool",
                                    "status": "started",
                                    "call_id": event.get("run_id", ""),
                                }
                            elif event_name == "on_tool_end":
                                observed_tool_event = True
                                yield {
                                    "type": "tool",
                                    "tool_name": event.get("name") or "tool",
                                    "status": "completed",
                                    "call_id": event.get("run_id", ""),
                                }
                            elif event_name == "on_tool_error":
                                observed_tool_event = True
                                yield {
                                    "type": "tool",
                                    "tool_name": event.get("name") or "tool",
                                    "status": "failed",
                                    "call_id": event.get("run_id", ""),
                                }
                            elif (
                                event_name in {"on_chain_end", "on_chat_model_end"}
                                and not full_answer.strip()
                            ):
                                output = event.get("data", {}).get("output", {})
                                full_answer = extract_agent_output_text(output)
                                if isinstance(output, dict) and output.get("stop_reason"):
                                    from src.agents.react_policy import summarize_react_state

                                    react_summary = summarize_react_state(output)
                            elif event_name == "on_chain_end":
                                output = event.get("data", {}).get("output", {})
                                if isinstance(output, dict) and output.get("stop_reason"):
                                    from src.agents.react_policy import summarize_react_state

                                    react_summary = summarize_react_state(output)
                    else:
                        # 兼容旧版 LangGraph 或测试替身，保留工具事件回退路径。
                        async for update in agent.astream(
                            {
                                "messages": [{"role": "user", "content": content}],
                                "user_id": user_id,
                            },
                            config=config,
                            stream_mode="updates",
                        ):
                            for node_name, state_update in update.items():
                                if isinstance(state_update, dict) and state_update.get("stop_reason"):
                                    from src.agents.react_policy import summarize_react_state

                                    react_summary = summarize_react_state(state_update)
                                messages = state_update.get("messages", [])
                                if not messages:
                                    continue
                                latest_message = messages[-1]
                                if node_name == "agent":
                                    tool_calls = getattr(latest_message, "tool_calls", [])
                                    for tool_call in tool_calls:
                                        observed_tool_event = True
                                        yield {
                                            "type": "tool",
                                            "tool_name": tool_call.get("name", "tool"),
                                            "status": "started",
                                            "call_id": tool_call.get("id", ""),
                                        }
                                    if not tool_calls and isinstance(latest_message.content, str):
                                        full_answer = strip_xml_tool_stream(latest_message.content)
                                elif node_name == "tools":
                                    observed_tool_event = True
                                    call_id = getattr(latest_message, "tool_call_id", "")
                                    yield {
                                        # 工具节点本身也是有效的流事件，不能被空答案兜底覆盖。
                                        "type": "tool",
                                        "tool_name": getattr(latest_message, "name", None) or "tool",
                                        "status": "completed",
                                        "call_id": call_id,
                                    }

                    visible_tail, stream_text_buffer = drain_xml_tool_stream(
                        stream_text_buffer, final=True
                    )
                    if visible_tail.strip():
                        full_answer += visible_tail
                        emitted_text = True
                        yield {"type": "text", "text": visible_tail}
                    full_answer = strip_xml_tool_stream(full_answer)

                    # 部分 OpenAI 兼容网关只在非流式工具调用中返回结构化 tool_calls。
                    if (
                        not full_answer.strip()
                        and not observed_tool_event
                        and hasattr(agent, "ainvoke")
                    ):
                        fallback_result = await agent.ainvoke(
                            {
                                "messages": [{"role": "user", "content": content}],
                                "user_id": user_id,
                            },
                            config=config,
                        )
                        full_answer = strip_xml_tool_stream(
                            extract_agent_output_text(fallback_result)
                        )
                        if isinstance(fallback_result, dict):
                            from src.agents.react_policy import summarize_react_state

                            react_summary = summarize_react_state(fallback_result)

            if full_answer.strip() and not emitted_text:
                async for text in stream_text_chunks(full_answer):
                    emitted_text = True
                    yield {"type": "text", "text": text}

            # 工具调用或模型空响应不能让 SSE 以无文本事件结束，否则前端会误判接口失败。
            if not full_answer.strip():
                full_answer = "抱歉，我没有理解您的问题。"
                emitted_text = True
                yield {"type": "text", "text": full_answer}

            final_answer = maybe_append_continuation_hint(full_answer)
            if final_answer != full_answer:
                yield {"type": "text", "text": final_answer[len(full_answer):]}
            schedule_answer_persistence(
                conversation_id, content, final_answer, user_id or ""
            )
            if react_summary:
                yield {
                    "type": "agent",
                    "event": "agent.complete",
                    "state": react_summary["state"],
                    "stop_reason": react_summary["stop_reason"],
                    "react": react_summary,
                }

        except TimeoutError:
            if full_answer.strip():
                partial = maybe_append_continuation_hint(full_answer)
                schedule_answer_persistence(
                    conversation_id, content, partial, user_id or ""
                )
                yield {"type": "text", "text": partial, "partial": True}
            else:
                timeout_answer = "AI助手响应超时，请稍后重试。"
                schedule_answer_persistence(
                    conversation_id, content, timeout_answer, user_id or ""
                )
                yield {"type": "text", "text": timeout_answer}
        except BusinessError:
            raise
        except Exception as error:
            logger.exception(
                "Agent stream failed | conversation_id=%s user_id=%s content=%r",
                conversation_id,
                user_id,
                content,
            )
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
