"""
指令注册中心
"""

from typing import Callable, Awaitable, Dict, List, Optional
from .qq import NormalizedMessage


class CommandRegistry:
    """指令注册中心 - 单例"""

    _instance = None
    _commands: Dict[str, Dict] = {}

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    def register(self, name: str, description: str):
        """装饰器：注册指令"""
        def decorator(func: Callable[[NormalizedMessage, List[str]], Awaitable[str]]):
            self._commands[name] = {
                "name": name,
                "description": description,
                "handler": func,
            }
            return func
        return decorator

    def register_handler(self, name: str, description: str, handler):
        """直接注册处理器"""
        self._commands[name] = {
            "name": name,
            "description": description,
            "handler": handler,
        }

    async def dispatch(self, msg: NormalizedMessage) -> Optional[str]:
        """分发指令"""
        parts = msg.content.strip().split()
        if not parts:
            return None

        command = parts[0].lower()
        args = parts[1:]

        entry = self._commands.get(command)
        if entry:
            return await entry["handler"](msg, args)

        return None

    def list_commands(self) -> List[Dict[str, str]]:
        """列出所有指令"""
        return [
            {"name": c["name"], "description": c["description"]}
            for c in self._commands.values()
        ]


# 全局实例
registry = CommandRegistry()
