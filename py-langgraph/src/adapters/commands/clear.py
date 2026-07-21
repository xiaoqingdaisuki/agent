"""
内置指令：/clear
"""

from src.adapters.registry import registry
from src.adapters.qq import NormalizedMessage


@registry.register("/clear", "清除当前会话记忆")
async def cmd_clear(msg: NormalizedMessage, args: list):
    """清除当前会话记忆"""
    # TODO: 实现清除 checkpoint
    return f"已清除会话 {msg.channel_id} 的对话历史"
