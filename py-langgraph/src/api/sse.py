"""Shared Server-Sent Events encoding helpers."""

import json
import asyncio
from collections.abc import AsyncIterator
from typing import Any
import logging
import anyio

_pending_settlements: set[asyncio.Task] = set()


# 将清理任务保留到完成，防止请求取消后丢失终态写入或重试。
def _retain_settlement(task: asyncio.Task) -> None:
    _pending_settlements.add(task)
    task.add_done_callback(_pending_settlements.discard)


# 在独立任务和线程中收敛 Turn，并在网关短暂失败时保留有界重试。
async def terminate_stream_turn(turn_id: str, user_id: str, cancelled: bool, code: str) -> bool:
    from src.services import TurnService

    # 保留原始终态及错误码重试，最终失败由网关陈旧轮次回收兜底。
    async def retry() -> None:
        for attempt in range(1, 3):
            await asyncio.sleep(attempt * 0.25)
            try:
                await asyncio.to_thread(TurnService.terminate, turn_id, user_id, cancelled, code)
                return
            except Exception:
                if attempt == 2:
                    logging.getLogger(__name__).exception(
                        "Turn settlement retries exhausted: %s", turn_id
                    )

    # 首次落库与重试调度共用独立任务，外层取消不会在两者之间遗失状态。
    async def persist() -> bool:
        try:
            await asyncio.to_thread(TurnService.terminate, turn_id, user_id, cancelled, code)
            return True
        except Exception:
            logging.getLogger(__name__).exception("Failed to settle stream Turn %s", turn_id)
            _retain_settlement(asyncio.create_task(retry()))
            return False

    task = asyncio.create_task(persist())
    _retain_settlement(task)
    with anyio.CancelScope(shield=True):
        return await asyncio.shield(task)


# 在正常关闭连接前等待已保留的终态写入及其后续重试。
async def flush_stream_settlements() -> None:
    while _pending_settlements:
        await asyncio.gather(*list(_pending_settlements))


# 保证取消发生在 Turn 创建期间时，也能清理线程中已经提交的活动轮次。
async def begin_stream_turn(
    conversation_id: str, user_id: str, content: str, client_message_id: str | None
):
    from src.services import TurnService

    task = asyncio.create_task(
        asyncio.to_thread(TurnService.begin, conversation_id, user_id, content, client_message_id)
    )
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        with anyio.CancelScope(shield=True):
            turn, created = await asyncio.shield(task)
            if created:
                await terminate_stream_turn(turn["id"], user_id, True, "CLIENT_CANCELLED")
        raise


# 统一编码 SSE 事件，兼容旧客户端继续读取 data 字段。
def encode_sse_event(event_name: str, payload: Any, event_id: str | None = None) -> str:
    prefix = f"id: {event_id}\n" if event_id else ""
    return f"{prefix}event: {event_name}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"


# 编码流结束事件，同时保留历史客户端使用的 [DONE] 标记。
def encode_sse_done(event_id: str | None = None) -> str:
    prefix = f"id: {event_id}\n" if event_id else ""
    return f'{prefix}event: done\ndata: {{"ok":true}}\n\ndata: [DONE]\n\n'


class SseEventSequencer:
    """为一个 turn 的 SSE 事件生成单调 ID。"""

    # 初始化指定 turn 的事件序列号。
    def __init__(self, turn_id: str):
        self._turn_id = turn_id
        self._sequence = 0

    # 编码带事件 ID 的标准 SSE 业务事件。
    def event(self, event_name: str, payload: dict[str, Any]) -> str:
        self._sequence += 1
        event_id = f"{self._turn_id}:{self._sequence}"
        return encode_sse_event(event_name, {**payload, "event_id": event_id}, event_id)

    # 编码带事件 ID 的流结束标记。
    def done(self) -> str:
        self._sequence += 1
        return encode_sse_done(f"{self._turn_id}:{self._sequence}")


# 编码不会进入用户文本流的 SSE 心跳注释。
def encode_sse_heartbeat() -> str:
    return ": ping\n\n"


# 在上游事件等待期间定期发送心跳，并在关闭时取消未完成的读取任务。
async def with_sse_heartbeats(
    events: AsyncIterator[dict], interval_seconds: float = 15.0, timeout_seconds: float = 270.0
) -> AsyncIterator[dict | None]:
    sentinel = object()
    queue: asyncio.Queue[dict | object] = asyncio.Queue(maxsize=1)
    producer_error: BaseException | None = None
    closing = False

    # 在单一任务中完整迭代上游，避免异步生成器跨 ContextVar 上下文恢复。
    async def produce() -> None:
        nonlocal producer_error
        try:
            async with asyncio.timeout(timeout_seconds):
                async for event in events:
                    await queue.put(event)
        except BaseException as error:
            producer_error = error
        finally:
            try:
                close = getattr(events, "aclose", None)
                if close is not None:
                    await close()
            except BaseException as error:
                if producer_error is None:
                    producer_error = error
            if not closing:
                await queue.put(sentinel)

    producer = asyncio.create_task(produce())
    try:
        while True:
            try:
                async with asyncio.timeout(interval_seconds):
                    item = await queue.get()
            except TimeoutError:
                yield None
                continue
            if item is sentinel:
                if producer_error is not None:
                    raise producer_error
                return
            yield item
    finally:
        closing = True
        if not producer.done():
            producer.cancel()
            try:
                await producer
            except asyncio.CancelledError:
                pass
