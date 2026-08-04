"""
tools — 工具 barrel 导出

职责：
1. 聚合所有工具实例、Descriptor 和运行时函数
2. 对外统一导出 `tools` 列表（供 Agent / ToolNode 使用）
3. 对外统一导出 `get_tools_for_user` / `get_tool_metadata_for_user`（供 API 使用）
"""

from src.tools.registry import (
    ToolRegistry,
    get_registry,
    get_tools_for_user,
    get_tool_metadata_for_user,
)

from .calculator import calculator
from .fetcher import web_read
from .file_reader import file_read
from .knowledge import knowledge_search
from .memory_session import memory_session_search
from .memory_user import memory_user_search, memory_user_save
from .search import web_search
from .weather import get_weather

tools = [
    get_weather,
    web_search,
    web_read,
    file_read,
    calculator,
    knowledge_search,
    memory_session_search,
    memory_user_search,
    memory_user_save,
]

__all__ = [
    "ToolRegistry",
    "calculator",
    "file_read",
    "get_registry",
    "get_tool_metadata_for_user",
    "get_tools_for_user",
    "get_weather",
    "knowledge_search",
    "memory_session_search",
    "memory_user_save",
    "memory_user_search",
    "tools",
    "web_read",
    "web_search",
]
