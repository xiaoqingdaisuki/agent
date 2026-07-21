"""
内置指令：/status
"""

import time
from src.adapters.registry import registry
from src.adapters.qq import NormalizedMessage


@registry.register("/status", "查看机器人状态")
async def cmd_status(msg: NormalizedMessage, args: list):
    """查看机器人状态"""
    uptime = time.time()
    hours = int(uptime // 3600)
    minutes = int((uptime % 3600) // 60)
    return f"运行中 | 在线时间: {hours}小时{minutes}分钟 | 平台: QQ"
