"""Shared Server-Sent Events encoding helpers."""

import json
from typing import Any


# 统一编码 SSE 事件，兼容旧客户端继续读取 data 字段。
def encode_sse_event(event_name: str, payload: Any) -> str:
    return f"event: {event_name}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"


# 编码流结束事件，同时保留历史客户端使用的 [DONE] 标记。
def encode_sse_done() -> str:
    return 'event: done\ndata: {"ok":true}\n\ndata: [DONE]\n\n'
