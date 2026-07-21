"""
QQ 机器人核心逻辑
"""

from .qq import QQAdapter, NormalizedMessage
from .registry import registry
from src.services import AgentService


class BotService:
    """QQ 机器人服务"""

    def __init__(self, adapter: QQAdapter):
        self.adapter = adapter

    async def start(self) -> None:
        """启动机器人"""
        await self.adapter.start(self._handle_message)

    async def _handle_message(self, msg: NormalizedMessage) -> None:
        """处理消息"""
        try:
            # 1. 先尝试匹配指令
            result = await registry.dispatch(msg)
            if result:
                await self.adapter.send(msg.channel_id, result, is_group=not msg.is_direct)
                return

            # 2. 非指令消息，交给 Agent 处理
            reply = await AgentService.chat(msg.channel_id, msg.content)
            await self.adapter.send(msg.channel_id, reply.content, is_group=not msg.is_direct)

        except Exception as e:
            print(f"Bot error: {e}")
            error_msg = "抱歉，处理您的消息时出现错误，请稍后重试。"
            await self.adapter.send(msg.channel_id, error_msg, is_group=not msg.is_direct)

    def get_commands(self):
        """获取可用指令列表"""
        return registry.list_commands()
