"""Shared Server-Sent Events encoding helpers."""

import json
import asyncio
from collections.abc import AsyncIterator
from typing import Any


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
    events: AsyncIterator[dict], interval_seconds: float = 15.0
) -> AsyncIterator[dict | None]:
    sentinel = object()
    queue: asyncio.Queue[dict | object] = asyncio.Queue(maxsize=1)
    producer_error: BaseException | None = None

    # 在单一任务中完整迭代上游，避免异步生成器跨 ContextVar 上下文恢复。
    async def produce() -> None:
        nonlocal producer_error
        try:
            async for event in events:
                await queue.put(event)
        except BaseException as error:
            producer_error = error
        finally:
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
        if not producer.done():
            producer.cancel()
            try:
                await producer
            except asyncio.CancelledError:
                pass
