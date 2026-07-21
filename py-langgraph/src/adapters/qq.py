"""
QQ 适配器 — OneBot v11 HTTP
"""

from typing import Optional
import httpx
import asyncio
from dataclasses import dataclass


@dataclass
class NormalizedMessage:
    """平台无关的统一消息格式"""
    platform: str = "qq"
    message_id: str = ""
    author_id: str = ""
    author_name: str = ""
    channel_id: str = ""
    content: str = ""
    mentions: list[str] = None
    timestamp: float = 0.0
    reply_to: Optional[str] = None
    is_direct: bool = False
    raw: dict = None

    def __post_init__(self):
        if self.mentions is None:
            self.mentions = []
        if self.raw is None:
            self.raw = {}


class QQAdapter:
    """OneBot v11 HTTP 适配器"""

    def __init__(
        self,
        base_url: str = "http://localhost:8080",
        poll_interval: float = 1.0,
    ):
        self.base_url = base_url.rstrip("/")
        self.poll_interval = poll_interval
        self.running = False
        self.last_message_id: str = ""
        self._message_handler = None

    async def start(self, on_message) -> None:
        """启动监听"""
        self.running = True
        self._message_handler = on_message
        print(f"QQ Adapter started, polling {self.base_url}/get_message")

        while self.running:
            try:
                await self._poll_messages()
            except Exception as e:
                print(f"QQ poll error: {e}")

            await asyncio.sleep(self.poll_interval)

    def stop(self) -> None:
        """停止监听"""
        self.running = False

    async def _poll_messages(self) -> None:
        """轮询消息"""
        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{self.base_url}/get_message",
                json={
                    "group_id": None,
                    "user_id": None,
                    "message_id": self.last_message_id or None,
                },
                timeout=10.0,
            )

            if response.status_code != 200:
                return

            data = response.json()
            if data.get("retcode") != 0 or not data.get("data"):
                return

            for raw_msg in data["data"]:
                if raw_msg.get("message_id", "") <= self.last_message_id:
                    continue

                self.last_message_id = raw_msg["message_id"]
                normalized = self._normalize(raw_msg)

                if normalized and self._message_handler:
                    await self._message_handler(normalized)

    def _normalize(self, raw: dict) -> Optional[NormalizedMessage]:
        """OneBot 消息 → NormalizedMessage"""
        message_type = raw.get("message_type", "")
        is_direct = message_type == "private"

        return NormalizedMessage(
            platform="qq",
            message_id=raw.get("message_id", ""),
            author_id=str(raw.get("user_id", "")),
            author_name=raw.get("sender", {}).get("nickname", f"User_{raw.get('user_id')}"),
            channel_id=str(
                raw.get("group_id") if message_type == "group" else raw.get("user_id")
            ),
            content=self._extract_text(raw),
            mentions=self._extract_mentions(raw),
            timestamp=raw.get("time", 0),
            reply_to=raw.get("reply", {}).get("message_id") if raw.get("reply") else None,
            is_direct=is_direct,
            raw=raw,
        )

    def _extract_text(self, raw: dict) -> str:
        """提取纯文本"""
        if isinstance(raw.get("raw_message"), str):
            return raw["raw_message"]

        message = raw.get("message", [])
        if isinstance(message, list):
            return "".join(
                seg.get("data", {}).get("text", "")
                for seg in message
                if seg.get("type") == "text"
            )

        return ""

    def _extract_mentions(self, raw: dict) -> list[str]:
        """提取 @ 列表"""
        mentions = []
        message = raw.get("message", [])

        if isinstance(message, list):
            for seg in message:
                if seg.get("type") == "at":
                    mentions.append(str(seg.get("data", {}).get("qq", "")))

        return mentions

    async def send(self, channel_id: str, content: str, is_group: bool = True) -> None:
        """发送消息"""
        endpoint = "send_group_msg" if is_group else "send_private_msg"
        id_field = "group_id" if is_group else "user_id"

        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{self.base_url}/{endpoint}",
                json={id_field: channel_id, "message": content},
                timeout=10.0,
            )

            if response.status_code != 200:
                raise Exception(f"Failed to send: {response.text}")
