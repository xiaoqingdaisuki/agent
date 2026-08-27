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
import json
import logging
import re
import uuid
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


# 过滤工具包装器产生的嵌套或重复生命周期事件，确保一次调用只展示一组进度。
def _accept_tool_lifecycle_event(
    event: dict,
    active_run_ids: set[str],
    completed_run_ids: set[str],
) -> bool:
    event_name = event.get("event")
    run_id = str(event.get("run_id") or "")
    parent_ids = {str(parent_id) for parent_id in event.get("parent_ids", []) or []}
    if parent_ids & active_run_ids:
        return False
    if not run_id:
        return True
    if event_name == "on_tool_start":
        if run_id in active_run_ids or run_id in completed_run_ids:
            return False
        active_run_ids.add(run_id)
        return True
    if run_id in completed_run_ids:
        return False
    active_run_ids.discard(run_id)
    completed_run_ids.add(run_id)
    return True


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
        for attempt in range(2):
            try:
                async with _get_background_semaphore():
                    await asyncio.to_thread(callback, *args)
                return
            except Exception:
                if attempt == 1:
                    logger.exception("Background task failed | label=%s", label)
                    return
                await asyncio.sleep(0.2 * (attempt + 1))

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


# 等待指定会话上一轮回答完成持久化，避免快速连续请求读取到不完整历史。
async def wait_for_conversation_persistence(conversation_id: str) -> None:
    task = _background_chains.get(f"answer:{conversation_id}")
    if task is None:
        return
    try:
        await asyncio.wait_for(
            asyncio.shield(task),
            timeout=settings.memory_request_timeout_ms / 1000,
        )
    except TimeoutError:
        logger.warning(
            "Conversation persistence still running; continuing request | conversation_id=%s",
            conversation_id,
        )
    except Exception:
        logger.warning(
            "Previous conversation persistence failed | conversation_id=%s",
            conversation_id,
        )


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


# 判断事件是否属于本次 Agent 调用的根运行，避免读取嵌套节点的历史状态快照。
def is_root_lifecycle_event(event: dict) -> bool:
    parent_ids = event.get("parent_ids")
    return not isinstance(parent_ids, list) or len(parent_ids) == 0


# 检测模型消息是否包含结构化工具调用，避免把工具规划文本当作最终回答。
def has_structured_tool_call(value) -> bool:
    if value is None:
        return False
    if isinstance(value, dict):
        tool_calls = value.get("tool_calls") or []
        tool_call_chunks = value.get("tool_call_chunks") or []
        additional_tool_calls = (value.get("additional_kwargs") or {}).get("tool_calls") or []
    else:
        tool_calls = getattr(value, "tool_calls", None) or []
        tool_call_chunks = getattr(value, "tool_call_chunks", None) or []
        additional_tool_calls = (
            getattr(value, "additional_kwargs", None) or {}
        ).get("tool_calls") or []
    return bool(tool_calls or tool_call_chunks or additional_tool_calls)


# 过滤 LangGraph/LangChain 事件中的结束哨兵和 XML 工具调用文本。
def normalize_agent_output_text(text: str) -> str:
    normalized = strip_xml_tool_stream(text)
    return "" if normalized.strip() == "__end__" else normalized


# 从 LangChain 链路结束事件中提取最终 AI 消息，兼容 output/output.messages 两种结构。
def extract_agent_output_text(output) -> str:
    if isinstance(output, str):
        return normalize_agent_output_text(output)
    if not isinstance(output, dict):
        get_type = getattr(output, "_get_type", None)
        output_type = get_type() if callable(get_type) else getattr(output, "type", "")
        return (
            normalize_agent_output_text(get_stream_text(output))
            if output_type in {"ai", "assistant"}
            else ""
        )
    nested = output.get("output")
    if isinstance(nested, str):
        return normalize_agent_output_text(nested)
    if isinstance(nested, dict):
        text = extract_agent_output_text(nested)
        if text:
            return text
    messages = output.get("messages")
    if isinstance(messages, list):
        current_turn_start = 0
        for index in range(len(messages) - 1, -1, -1):
            message = messages[index]
            if isinstance(message, dict):
                message_type = message.get("type") or message.get("role", "")
            else:
                get_type = getattr(message, "_get_type", None)
                message_type = get_type() if callable(get_type) else getattr(message, "type", "")
            if message_type in {"human", "user"}:
                current_turn_start = index + 1
                break
        for message in reversed(messages[current_turn_start:]):
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


# 判断异常链中是否包含模型或网络读取超时。
def is_model_timeout_error(error: BaseException) -> bool:
    current: BaseException | None = error
    visited: set[int] = set()
    while current is not None and id(current) not in visited:
        visited.add(id(current))
        if current.__class__.__name__ in {"APITimeoutError", "ReadTimeout"}:
            return True
        current = current.__cause__ or current.__context__
    return False


# 判断用户是否明确要求查询知识库，以绕过不稳定的模型工具规划。
def is_explicit_knowledge_query(content: str) -> bool:
    normalized = re.sub(r"\s+", "", content)
    return bool(
        re.search(r"(?:从|在|查询|搜索|检索|查找).{0,10}(?:知识库|资料库)", normalized)
        or re.search(r"(?:知识库|资料库).{0,10}(?:查询|搜索|检索|查找)", normalized)
    )


XML_TOOL_STREAM_MARKERS = ("<invoke", "<function=", "<dots_function_call")


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
        close = (
            "</invoke>"
            if rest.startswith("<invoke")
            else "</dots_function_call>"
            if rest.startswith("<dots_function_call")
            else "</function>"
        )
        close_index = rest.find(close)
        if close_index == -1:
            return visible, buffer[marker_index:]
        cursor = marker_index + close_index + len(close)
    return visible, ""


# 清理非流式回退路径中的 XML 工具调用文本。
def strip_xml_tool_stream(text: str) -> str:
    """Remove complete XML tool calls from a complete model response."""
    return drain_xml_tool_stream(text, final=True)[0].strip()


# 串行执行非关键记忆与画像补充，避免阻塞响应关键路径。
def schedule_answer_persistence(
    conversation_id: str,
    content: str,
    answer: str,
    user_id: str = "",
) -> asyncio.Task[None]:
    # 同步写入会话、问答历史、记忆和画像。
    def persist() -> None:
        if user_id:
            from src.profile.service import MemoryService, ProfileService

            if settings.memory_auto_extract:
                MemoryService.extract_memories_from_conversation(user_id, content, answer)
            ProfileService.update(user_id)

    label = f"answer:{conversation_id}"
    previous = _background_chains.get(label)

    # 串行执行同一会话的回答落库，失败交给当前请求转换为统一错误。
    async def runner() -> None:
        if previous:
            try:
                await asyncio.shield(previous)
            except Exception:
                pass
        try:
            await asyncio.to_thread(persist)
        except Exception as error:
            logger.warning(
                "Non-critical answer enrichment failed for conversation %s: %s",
                conversation_id,
                error,
            )

    task = asyncio.create_task(runner(), name=f"agent-answer-{conversation_id}")
    _background_tasks.add(task)
    _background_chains[label] = task

    # 清理已完成的回答任务，避免进程内状态无限增长。
    def cleanup(done_task: asyncio.Task) -> None:
        _background_tasks.discard(done_task)
        if _background_chains.get(label) is done_task:
            _background_chains.pop(label, None)

    task.add_done_callback(cleanup)
    return task


# 将模型完整回答按可见字符拆成平滑的 SSE 分片，避免依赖厂商工具流格式
async def stream_text_chunks(text: str):
    for index in range(0, len(text), STREAM_FALLBACK_CHUNK_SIZE):
        yield text[index : index + STREAM_FALLBACK_CHUNK_SIZE]
        if index + STREAM_FALLBACK_CHUNK_SIZE < len(text):
            await asyncio.sleep(STREAM_FALLBACK_INTERVAL_SECONDS)


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
    TURN_IN_PROGRESS = "TURN_IN_PROGRESS"
    TURN_ALREADY_FINISHED = "TURN_ALREADY_FINISHED"


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
    @staticmethod
    # 将原子 Turn 命令已持久化的消息同步到进程缓存。
    def cache_persisted_message(conv_id: str, message: Message) -> None:
        conv = _conversations.get(conv_id)
        if not conv:
            return
        if not any(item.id == message.id for item in conv.messages):
            conv.messages.append(message)
            if message.role == "user":
                conv.message_count += 1

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
    # 确保会话存在于当前仓储，不存在则创建，并同步服务缓存。
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

        # 先检查当前仓储，兼容进程内和 Cloudflare 两种实现。
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
    # 根据 ID 获取会话详情，服务缓存未命中时从当前仓储加载。
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
    # 列出指定用户的会话，并以当前仓储结果刷新服务缓存。
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
    # 删除会话及其关联消息，同时从 D1 删除
    def delete(conv_id: str) -> bool:
        from src.repositories import get_repositories

        deleted = get_repositories().delete_conversation(conv_id)
        if not deleted:
            return False
        _conversations.pop(conv_id, None)
        return True

    @staticmethod
    # 向会话追加一条用户消息，同时持久化到 D1
    def append_user_message(conv_id: str, content: str, user_id: str = "") -> Message:
        conv = _conversations.get(conv_id)
        if not conv:
            raise BusinessError(BusinessErrorCode.NOT_FOUND, "Conversation not found", 404)
        conv.message_count += 1
        message = Message("user", content)
        conv.messages.append(message)

        from src.repositories import get_repositories

        get_repositories().create_message_batch(
            conv_id,
            user_id or conv.user_id,
            [{
                "id": message.id,
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
        existing = next((item for item in conv.messages if item.id == message.id), None)
        persisted_message = existing or message
        if existing is None:
            conv.messages.append(persisted_message)

        from src.repositories import get_repositories

        get_repositories().create_message_batch(
            conv_id,
            user_id or conv.user_id,
            [{
                "id": persisted_message.id,
                "role": "assistant",
                "content": persisted_message.content,
                "created_at": persisted_message.created_at,
            }],
        )

    @staticmethod
    # 获取会话的全部消息列表，优先刷新仓储并以进程缓存作为故障兜底。
    def get_messages(conv_id: str) -> list[dict]:
        conv = _conversations.get(conv_id)
        cached = [message.to_dict() for message in conv.messages] if conv else []

        try:
            from src.repositories import get_repositories
            repos = get_repositories()
            messages_data = []
            offset = 0
            total = 0
            while True:
                page, total = repos.get_messages(conv_id, 200, offset)
                if not page:
                    break
                messages_data.extend(page)
                offset += len(page)
                if len(messages_data) >= total:
                    break
            if not messages_data and cached:
                return cached
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
                        m["content"],
                        message_id=m["id"],
                        created_at=m["created_at"],
                    )
                    for m in loaded
                ]
                conv.message_count = sum(m.role == "user" for m in conv.messages)

            return loaded
        except Exception as exc:
            logger.warning("[service] D1 get messages for conv %s failed: %s", conv_id, exc)
            return cached

    @staticmethod
    # 获取提供给 Agent 的对话上下文，保留用户与助手消息作为补充信息源。
    def get_agent_conversation_history(
        conv_id: str, current_content: str | None = None
    ) -> list[dict[str, str]]:
        try:
            from src.repositories import get_repositories

            recent, _total = get_repositories().get_messages(conv_id, 200, 0, "desc")
            source_messages = list(reversed(recent))
        except Exception:
            source_messages = ConversationService.get_messages(conv_id)
        history = [
            {
                "role": str(message.get("role", "")),
                "content": str(message.get("content", "")),
            }
            for message in source_messages
            if message.get("role") in {"user", "assistant"}
            and str(message.get("content", "")).strip()
        ]
        if (
            current_content
            and history
            and history[-1]["role"] == "user"
            and history[-1]["content"] == current_content
        ):
            history.pop()
        return history

    @staticmethod
    # 清空会话消息列表和关联状态
    def clear_messages(conv_id: str) -> None:
        conv = _conversations.get(conv_id)
        if conv:
            conv.messages.clear()
            conv.message_count = 0
        from src.repositories import get_repositories

        get_repositories().clear_messages(conv_id)


# ============ Knowledge Service ============

# memory_enabled=false 时保存进程内文档、原文、分块及字符倒排索引，进程重启后数据清空。
_documents: dict[str, Document] = {}
_document_contents: dict[str, tuple[bytes, str]] = {}
_document_chunks: dict[str, list[str]] = {}
_document_owners: dict[str, str] = {}
_LOCAL_KNOWLEDGE_SCOPE = "local"
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
def _search_local_documents(
    query: str,
    top_k: int,
    user_id: str,
    document_ids: list[str] | None = None,
) -> list[dict]:
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
        if not entry or not document or _document_owners.get(document.id) != user_id:
            continue
        # 限定检索文件范围（file.search 过滤当前用户的指定文件）。
        if document_ids and document.id not in document_ids:
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
            "degraded": True,
        }
        if len(results) < top_k:
            results.append(result)
            continue
        lowest_index = min(range(len(results)), key=lambda index: results[index]["score"])
        if score > results[lowest_index]["score"]:
            results[lowest_index] = result
    return sorted(results, key=lambda item: item["score"], reverse=True)


class KnowledgeService:
    """文档知识库服务 — 支持进程内倒排检索与 Cloudflare Gateway"""

    @staticmethod
    # 创建或注册 upload document 所需的数据
    async def upload_document(
        buffer: bytes,
        filename: str,
        category: str = None,
        user_id: str = _LOCAL_KNOWLEDGE_SCOPE,
    ) -> Document:
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
                _document_owners[document.id] = user_id
                _document_contents[document.id] = (buffer, filename)
                _document_chunks[document.id] = chunks
                _replace_local_document_search_index(document.id, chunks)
                return document

            import base64

            from src.clients.memory_gateway import CloudflareMemoryClient

            client = CloudflareMemoryClient()
            # 使用默认用户上传（共享知识库）
            result = await client.upload_document(
                user_id=user_id,
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
            _document_owners[document.id] = user_id
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
    async def list_documents(user_id: str = _LOCAL_KNOWLEDGE_SCOPE) -> list[dict]:
        """列出文档；本地模式读取进程内索引，网关模式以远端仓储为权威"""
        if not settings.memory_enabled:
            return sorted(
                [document.to_dict() for document in _documents.values() if _document_owners.get(document.id) == user_id],
                key=lambda document: document["created_at"],
                reverse=True,
            )
        try:
            from src.clients.memory_gateway import CloudflareMemoryClient
            client = CloudflareMemoryClient()
            result = await client.list_documents(user_id, limit=100)
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
                _document_owners[d["id"]] = user_id

                # 缓存原始内容用于 reindex
                content_text = d.get("content_text", "")
                if content_text:
                    _document_contents[d["id"]] = (content_text.encode("utf-8"), d["name"])
            return sorted(docs, key=lambda d: d["created_at"], reverse=True)
        except Exception:
            return sorted(
                [d.to_dict() for d in _documents.values() if _document_owners.get(d.id) == user_id],
                key=lambda d: d["created_at"],
                reverse=True,
            )

    @staticmethod
    # 获取 get document 对应的数据
    async def get_document(doc_id: str, user_id: str = _LOCAL_KNOWLEDGE_SCOPE) -> Document | None:
        """获取文档详情；本地模式只读进程内数据，网关模式允许远端回源"""
        cached = _documents.get(doc_id)
        if cached:
            return cached if _document_owners.get(doc_id) == user_id else None
        if not settings.memory_enabled:
            return None

        scoped_documents = await KnowledgeService.list_documents(user_id)
        if not any(document["id"] == doc_id for document in scoped_documents):
            return None

        # 从当前仓储回源并刷新服务缓存。
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
            _document_owners[doc_id] = user_id

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
    async def delete_document(doc_id: str, user_id: str = _LOCAL_KNOWLEDGE_SCOPE) -> bool:
        """删除指定文档及其向量索引"""
        if not await KnowledgeService.get_document(doc_id, user_id):
            return False
        if not settings.memory_enabled:
            _remove_local_document_search_index(doc_id)
            deleted = _documents.pop(doc_id, None) is not None
            _document_contents.pop(doc_id, None)
            _document_chunks.pop(doc_id, None)
            _document_owners.pop(doc_id, None)
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
        _document_owners.pop(doc_id, None)
        _document_contents.pop(doc_id, None)
        _document_chunks.pop(doc_id, None)
        _remove_local_document_search_index(doc_id)
        return True

    @staticmethod
    # 执行 reindex document 对应的业务逻辑
    async def reindex_document(doc_id: str, user_id: str = _LOCAL_KNOWLEDGE_SCOPE) -> Document:
        """重新索引；本地模式重切进程内原文，网关模式允许远端回源"""
        if not await KnowledgeService.get_document(doc_id, user_id):
            raise BusinessError(BusinessErrorCode.NOT_FOUND, "Document not found", 404)
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
            document = await KnowledgeService.get_document(doc_id, user_id)
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
    async def search(
        query: str,
        top_k: int = 5,
        user_id: str = _LOCAL_KNOWLEDGE_SCOPE,
        document_ids: list[str] | None = None,
    ) -> list[dict]:
        """知识检索"""
        if not settings.memory_enabled:
            return _search_local_documents(query, top_k, user_id, document_ids)
        try:
            from src.clients.memory_gateway import CloudflareMemoryClient

            client = CloudflareMemoryClient()
            result = await client.search_documents(
                user_id=user_id,
                query=query,
                limit=top_k,
                document_ids=document_ids,
            )

            degraded = bool(result.get("degraded", False))
            return [
                {
                    "document_id": r.get("document_id", ""),
                    "document_name": r.get("metadata", {}).get("document_name", "") or r.get("metadata", {}).get("filename", ""),
                    "content": r.get("content", ""),
                    "score": r.get("score", 0),
                    "chunk_index": r.get("chunk_index"),
                    "degraded": degraded,
                }
                for r in result.get("results", [])
            ]
        except Exception:
            raise BusinessError(
                BusinessErrorCode.SERVICE_UNAVAILABLE,
                "知识库检索失败，请稍后重试",
                503,
            )

    @staticmethod
    # 直接格式化知识库检索结果，避免再次调用模型造成超时。
    async def chat(
        content: str,
        _history: list | None = None,
        user_id: str = _LOCAL_KNOWLEDGE_SCOPE,
    ) -> dict:
        results = await KnowledgeService.search(content, 5, user_id)
        if not results:
            return {
                "output": "📚 知识库中未找到与您问题相关的内容。请尝试换一种方式提问，或联系管理员更新知识库。"
            }
        context = "\n\n".join(
            f"[文档 {index}] {result['document_name']} (相关度: {float(result['score']):.2f})\n{result['content']}"
            for index, result in enumerate(results, start=1)
        )
        return {"output": f"📚 根据知识库检索结果：\n\n{context}"}


# ============ Turn Service ============


class TurnService:
    @staticmethod
    # 创建或复用客户端消息对应的持久化 Turn。
    def begin(
        conversation_id: str,
        user_id: str,
        content: str,
        client_message_id: str | None = None,
    ) -> tuple[dict, bool]:
        from src.repositories import get_repositories
        from src.clients.memory_gateway import MemoryGatewayError

        try:
            turn, user_message, created = get_repositories().begin_turn(
                conversation_id,
                user_id,
                client_message_id or str(uuid.uuid4()),
                content,
            )
            if created:
                ConversationService.cache_persisted_message(
                    conversation_id,
                    Message(
                        "user",
                        user_message["content_json"],
                        user_message["id"],
                        user_message["created_at"],
                    ),
                )
            return turn, created
        except MemoryGatewayError as error:
            if error.code == "MEMORY_CONVERSATION_BUSY":
                raise BusinessError(
                    BusinessErrorCode.TURN_IN_PROGRESS,
                    "该会话已有请求正在处理中",
                    409,
                ) from error
            raise

    @staticmethod
    # 将新 Turn 标记为执行中并关联已落库的用户消息。
    def start(turn_id: str, user_id: str, user_message_id: str) -> dict:
        from src.repositories import get_repositories

        return get_repositories().update_turn(
            turn_id, user_id, status="streaming", user_message_id=user_message_id
        )

    @staticmethod
    # 将 Turn 完成并保存可直接复用的助手响应。
    def complete(turn_id: str, user_id: str, message: Message) -> dict:
        from src.repositories import get_repositories

        turn = get_repositories().complete_turn(
            turn_id,
            user_id,
            {
                "id": message.id,
                "conversation_id": "",
                "user_id": user_id,
                "sequence_no": 0,
                "role": "assistant",
                "content_json": message.content,
                "created_at": message.created_at,
            },
        )
        ConversationService.cache_persisted_message(turn["conversation_id"], message)
        return turn

    @staticmethod
    # 将执行异常或客户端取消记录为终态。
    def terminate(turn_id: str, user_id: str, cancelled: bool, error_code: str) -> dict:
        from src.repositories import get_repositories

        return get_repositories().update_turn(
            turn_id,
            user_id,
            status="cancelled" if cancelled else "failed",
            error_code=error_code,
        )

    @staticmethod
    # 从已完成 Turn 中恢复助手响应。
    def completed_message(turn: dict) -> Message | None:
        if turn.get("status") != "completed" or not turn.get("assistant_content_json"):
            return None
        try:
            parsed = json.loads(turn["assistant_content_json"])
            if parsed.get("role") != "assistant" or not isinstance(parsed.get("content"), str):
                return None
            return Message(
                "assistant", parsed["content"], parsed.get("id"), parsed.get("created_at")
            )
        except (TypeError, ValueError, json.JSONDecodeError):
            return None

    @staticmethod
    # 将重复的非终态或失败 Turn 转换为稳定业务错误。
    def duplicate_error(status: str) -> BusinessError:
        if status in {"pending", "streaming"}:
            return BusinessError(
                BusinessErrorCode.TURN_IN_PROGRESS,
                "相同 client_message_id 的请求正在处理中",
                409,
            )
        return BusinessError(
            BusinessErrorCode.TURN_ALREADY_FINISHED,
            f"该 Turn 已处于 {status} 状态，请使用新的 client_message_id",
            409,
        )


# ============ Agent Service ============


class AgentService:
    # 执行对话，调用 Agent 并处理错误转换
    @staticmethod
    # 执行 chat 对应的业务逻辑
    async def chat(
        conversation_id: str,
        content: str,
        user_id: str = None,
        tool_identity: dict[str, str | list[str]] | None = None,
    ) -> Message:
        try:
            await wait_for_conversation_persistence(conversation_id)
            from src.agents.graph_agents import (
                AGENT_RECURSION_LIMIT,
                build_chat_agent,
                build_tool_agent,
                get_fast_path_answer,
                is_direct_chat_message,
            )
            from src.agents.deadline import AgentDeadline
            from src.agents.response_handler import (
                get_finish_reason_from_output,
                is_likely_truncated,
                maybe_append_continuation_hint,
            )
            from src.profile.service import HistoryService, MemoryService, ProfileService

            fast_answer = get_fast_path_answer(content)
            if fast_answer:
                schedule_answer_persistence(conversation_id, content, fast_answer, user_id or "")
                return Message("assistant", fast_answer)

            conversation = ConversationService.get(conversation_id)
            if is_explicit_knowledge_query(content):
                knowledge_scope = user_id or "anonymous"
                result = await KnowledgeService.chat(content, user_id=knowledge_scope)
                reply_content = str(result["output"])
                schedule_answer_persistence(
                    conversation_id, content, reply_content, user_id or ""
                )
                return Message("assistant", reply_content)

            agent_thread_id = conversation_id
            agent = (
                (
                    build_chat_agent()
                    if is_direct_chat_message(content)
                    else build_tool_agent()
                )
                if not conversation or conversation.mode != "knowledge"
                else None
            )
            conversation_history = ConversationService.get_agent_conversation_history(
                conversation_id, content
            )
            config = {
                "configurable": {"thread_id": agent_thread_id},
                "recursion_limit": AGENT_RECURSION_LIMIT,
            }
            if user_id:
                config["configurable"]["user_id"] = user_id

            runtime_context = create_tool_call_context(
                user_id or "",
                conversation_id,
                tenant_id=str((tool_identity or {}).get("tenant_id", f"user:{user_id or 'anonymous'}")),
                roles=list((tool_identity or {}).get("roles", ["member"])),
            )
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
                                "conversation_history": conversation_history,
                                "context": [],
                                "should_retrieve": True,
                                "user_id": user_id or "",
                            }
                        )
                    else:
                        result = await agent.ainvoke(
                            {
                                "messages": [{"role": "user", "content": content}],
                                "conversation_history": conversation_history,
                                "user_id": user_id,
                            },
                            config=config,
                        )

            reply_content = extract_agent_output_text(result) or "抱歉，我没有理解您的问题。"

            # 检测 LLM 输出截断
            finish_reason = get_finish_reason_from_output(result)
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
            error_msg = str(error)
            if error.__class__.__name__ == "ModelCapacityError":
                raise BusinessError(
                    BusinessErrorCode.RATE_LIMITED,
                    "AI 服务并发已满，请稍后重试",
                    429,
                ) from error
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
            logger.exception(
                "Agent chat failed | conversation_id=%s user_id=%s content=%r",
                conversation_id,
                user_id,
                content,
            )
            raise BusinessError(
                BusinessErrorCode.INTERNAL_ERROR,
                "处理请求时发生错误，请稍后重试",
                500,
            )

    # 流式对话，逐字返回 AI 回复和工具调用事件
    @staticmethod
    # 执行 chat stream 对应的业务逻辑
    async def chat_stream(
        conversation_id: str,
        content: str,
        user_id: str = None,
        tool_identity: dict[str, str | list[str]] | None = None,
    ):
        full_answer = ""
        stream_text_buffer = ""
        emitted_text = False
        observed_tool_event = False
        last_tool_output = ""
        react_summary = None
        root_answer = ""
        stream_finish_reason = None
        try:
            await wait_for_conversation_persistence(conversation_id)
            from src.agents.graph_agents import (
                AGENT_RECURSION_LIMIT,
                build_chat_agent,
                build_tool_agent,
                get_fast_path_answer,
                is_direct_chat_message,
            )
            from src.agents.deadline import AgentDeadline
            from src.agents.response_handler import (
                append_continuation_hint,
                get_finish_reason_from_output,
                maybe_append_continuation_hint,
            )
            from src.profile.service import HistoryService, MemoryService, ProfileService

            fast_answer = get_fast_path_answer(content)
            if fast_answer:
                schedule_answer_persistence(conversation_id, content, fast_answer, user_id or "")
                yield {"type": "text", "text": fast_answer}
                return

            conversation = ConversationService.get(conversation_id)
            if is_explicit_knowledge_query(content):
                knowledge_scope = user_id or "anonymous"
                result = await KnowledgeService.chat(content, user_id=knowledge_scope)
                full_answer = str(result["output"])
                schedule_answer_persistence(
                    conversation_id, content, full_answer, user_id or ""
                )
                yield {"type": "text", "text": full_answer}
                return

            agent_thread_id = conversation_id
            runtime_context = create_tool_call_context(
                user_id or "",
                conversation_id,
                tenant_id=str((tool_identity or {}).get("tenant_id", f"user:{user_id or 'anonymous'}")),
                roles=list((tool_identity or {}).get("roles", ["member"])),
            )
            conversation_history = ConversationService.get_agent_conversation_history(
                conversation_id, content
            )
            if conversation and conversation.mode == "knowledge":
                from langchain_core.messages import HumanMessage
                from src.rag.rag_agent import build_rag_agent

                rag_agent = build_rag_agent()
                rag_finish_reason = None
                with tool_call_scope(runtime_context):
                    async with AgentDeadline():
                        rag_input = {
                            "messages": [HumanMessage(content=content)],
                            "conversation_history": conversation_history,
                            "context": [],
                            "should_retrieve": True,
                            "user_id": user_id or "",
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
                                    and is_root_lifecycle_event(event)
                                ):
                                    output = event.get("data", {}).get("output", {})
                                    full_answer = extract_agent_output_text(output)
                                if event.get("event") in {"on_chain_end", "on_chat_model_end"}:
                                    finish_reason = get_finish_reason_from_output(
                                        event.get("data", {}).get("output")
                                    )
                                    if finish_reason:
                                        rag_finish_reason = finish_reason
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
                final_answer = maybe_append_continuation_hint(
                    raw_answer, rag_finish_reason
                )
                if final_answer != raw_answer:
                    yield {"type": "text", "text": final_answer[len(raw_answer):]}
                schedule_answer_persistence(
                    conversation_id, content, final_answer, user_id or ""
                )
                return

            direct_chat = is_direct_chat_message(content)
            agent = (
                build_chat_agent()
                if direct_chat
                else build_tool_agent()
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
                    completed_model_answer = ""
                    model_text_buffers: dict[str, str] = {}
                    model_tool_runs: set[str] = set()
                    active_tool_run_ids: set[str] = set()
                    completed_tool_run_ids: set[str] = set()
                    if hasattr(agent, "astream_events"):
                        async for event in agent.astream_events(
                            {
                                "messages": [{"role": "user", "content": content}],
                                "conversation_history": conversation_history,
                                "user_id": user_id,
                            },
                            config=config,
                            version="v2",
                        ):
                            event_name = event.get("event")
                            if event_name == "on_chat_model_stream":
                                delta = get_stream_text(event.get("data", {}).get("chunk"))
                                if delta:
                                    if direct_chat:
                                        stream_text_buffer += delta
                                        visible, stream_text_buffer = drain_xml_tool_stream(
                                            stream_text_buffer
                                        )
                                        if visible.strip() or emitted_text:
                                            full_answer += visible
                                            emitted_text = True
                                            yield {"type": "text", "text": visible}
                                    else:
                                        run_id = str(event.get("run_id") or "model")
                                        model_text_buffers[run_id] = (
                                            model_text_buffers.get(run_id, "") + delta
                                        )
                                        if has_structured_tool_call(
                                            event.get("data", {}).get("chunk")
                                        ):
                                            model_tool_runs.add(run_id)
                            elif event_name == "on_chat_model_end":
                                finish_reason = get_finish_reason_from_output(
                                    event.get("data", {}).get("output")
                                )
                                if finish_reason:
                                    stream_finish_reason = finish_reason
                                run_id = str(event.get("run_id") or "model")
                                buffered = model_text_buffers.get(run_id, "")
                                output = event.get("data", {}).get("output")
                                is_tool_run = (
                                    run_id in model_tool_runs
                                    or has_structured_tool_call(output)
                                    or bool(
                                        re.search(
                                            r"<invoke\b|<function=|<dots_function_call\b",
                                            buffered,
                                            re.IGNORECASE,
                                        )
                                    )
                                )
                                if not direct_chat and not is_tool_run:
                                    candidate = strip_xml_tool_stream(
                                        buffered
                                    ) or extract_agent_output_text(output)
                                    if candidate.strip():
                                        completed_model_answer = candidate
                                model_text_buffers.pop(run_id, None)
                                model_tool_runs.discard(run_id)
                                if is_root_lifecycle_event(event):
                                    candidate = extract_agent_output_text(output)
                                    if candidate.strip():
                                        root_answer = candidate
                            elif event_name == "on_tool_start":
                                if not _accept_tool_lifecycle_event(
                                    event, active_tool_run_ids, completed_tool_run_ids
                                ):
                                    continue
                                observed_tool_event = True
                                yield {
                                    "type": "tool",
                                    "tool_name": event.get("name") or "tool",
                                    "status": "started",
                                    "call_id": event.get("run_id", ""),
                                }
                            elif event_name == "on_tool_end":
                                if not _accept_tool_lifecycle_event(
                                    event, active_tool_run_ids, completed_tool_run_ids
                                ):
                                    continue
                                observed_tool_event = True
                                tool_output = get_stream_text(
                                    event.get("data", {}).get("output")
                                ).strip()
                                if tool_output:
                                    last_tool_output = tool_output
                                yield {
                                    "type": "tool",
                                    "tool_name": event.get("name") or "tool",
                                    "status": "completed",
                                    "call_id": event.get("run_id", ""),
                                }
                            elif event_name == "on_tool_error":
                                if not _accept_tool_lifecycle_event(
                                    event, active_tool_run_ids, completed_tool_run_ids
                                ):
                                    continue
                                observed_tool_event = True
                                yield {
                                    "type": "tool",
                                    "tool_name": event.get("name") or "tool",
                                    "status": "failed",
                                    "call_id": event.get("run_id", ""),
                                }
                            elif event_name == "on_chain_end":
                                output = event.get("data", {}).get("output", {})
                                if is_root_lifecycle_event(event):
                                    candidate = extract_agent_output_text(output)
                                    if candidate.strip():
                                        root_answer = candidate
                                if isinstance(output, dict) and output.get("stop_reason"):
                                    from src.agents.react_policy import summarize_react_state

                                    react_summary = summarize_react_state(output)
                    else:
                        # 兼容旧版 LangGraph 或测试替身，保留工具事件回退路径。
                        async for update in agent.astream(
                            {
                                "messages": [{"role": "user", "content": content}],
                                "conversation_history": conversation_history,
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

                    if direct_chat:
                        visible_tail, stream_text_buffer = drain_xml_tool_stream(
                            stream_text_buffer, final=True
                        )
                        if visible_tail.strip():
                            full_answer += visible_tail
                            emitted_text = True
                            yield {"type": "text", "text": visible_tail}
                    full_answer = strip_xml_tool_stream(full_answer)
                    authoritative_answer = strip_xml_tool_stream(
                        root_answer or completed_model_answer
                    )
                    if not full_answer.strip() and authoritative_answer.strip():
                        full_answer = authoritative_answer

                    # 部分 OpenAI 兼容网关只在非流式工具调用中返回结构化 tool_calls。
                    if (
                        not full_answer.strip()
                        and not observed_tool_event
                        and hasattr(agent, "ainvoke")
                    ):
                        fallback_result = await agent.ainvoke(
                            {
                                "messages": [{"role": "user", "content": content}],
                                "conversation_history": conversation_history,
                                "user_id": user_id,
                            },
                            config=config,
                        )
                        full_answer = strip_xml_tool_stream(
                            extract_agent_output_text(fallback_result)
                        )
                        stream_finish_reason = get_finish_reason_from_output(fallback_result)
                        if isinstance(fallback_result, dict):
                            from src.agents.react_policy import summarize_react_state

                            react_summary = summarize_react_state(fallback_result)

            if full_answer.strip() and not emitted_text:
                if direct_chat:
                    async for text in stream_text_chunks(full_answer):
                        emitted_text = True
                        yield {"type": "text", "text": text}
                else:
                    emitted_text = True
                    yield {"type": "text", "text": full_answer}

            # 工具调用或模型空响应不能让 SSE 以无文本事件结束，否则前端会误判接口失败。
            if not full_answer.strip():
                full_answer = "抱歉，我没有理解您的问题。"
                emitted_text = True
                yield {"type": "text", "text": full_answer}

            final_answer = maybe_append_continuation_hint(full_answer, stream_finish_reason)
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
                partial = append_continuation_hint(full_answer)
                schedule_answer_persistence(
                    conversation_id, content, partial, user_id or ""
                )
                yield {
                    "type": "text",
                    "text": partial[len(full_answer) :],
                    "partial": True,
                }
            else:
                timeout_answer = "AI助手响应超时，请稍后重试。"
                schedule_answer_persistence(
                    conversation_id, content, timeout_answer, user_id or ""
                )
                yield {"type": "text", "text": timeout_answer}
        except BusinessError:
            raise
        except Exception as error:
            error_msg = str(error)
            if error.__class__.__name__ == "ModelCapacityError":
                raise BusinessError(
                    BusinessErrorCode.RATE_LIMITED,
                    "AI 服务并发已满，请稍后重试",
                    429,
                ) from error
            if is_model_timeout_error(error):
                if full_answer.strip():
                    timeout_answer = append_continuation_hint(full_answer)
                    suffix = timeout_answer[len(full_answer) :]
                elif last_tool_output:
                    timeout_answer = last_tool_output
                    suffix = timeout_answer
                else:
                    timeout_answer = "AI助手响应超时，请稍后重试。"
                    suffix = timeout_answer
                schedule_answer_persistence(
                    conversation_id, content, timeout_answer, user_id or ""
                )
                if suffix:
                    yield {"type": "text", "text": suffix, "partial": True}
                return
            if "rate limit" in error_msg.lower():
                raise BusinessError(
                    BusinessErrorCode.SERVICE_UNAVAILABLE,
                    "AI 服务暂时繁忙，请稍后重试",
                    503,
                )
            logger.exception(
                "Agent stream failed | conversation_id=%s user_id=%s",
                conversation_id,
                user_id,
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
    "TurnService",
    "wait_for_conversation_persistence",
]
