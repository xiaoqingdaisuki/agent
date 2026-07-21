"""
内置指令：/help
"""

from src.adapters.registry import registry
from src.adapters.qq import NormalizedMessage


@registry.register("/help", "列出所有可用指令")
async def cmd_help(msg: NormalizedMessage, args: list):
    """列出所有可用指令"""
    commands = registry.list_commands()
    lines = [f"  {c['name']} - {c['description']}" for c in commands]
    return f"可用指令：\n" + "\n".join(lines)
