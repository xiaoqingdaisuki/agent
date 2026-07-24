"""
Tool Registry — 工具注册、发现和动态裁剪

职责:
1. 注册所有可用工具及其 Descriptor
2. 根据用户权限动态裁剪可见工具集
3. 提供工具元数据查询（/tools API 使用）
"""

from __future__ import annotations

from typing import Any

from src.tools.contracts import ToolDescriptor, ToolCategory
from src.tools.runtime.executor import ToolExecutor, invoke_tool, get_audit_log, clear_audit_log
from src.tools.weather import get_weather, _DESCRIPTOR as WEATHER_DESCRIPTOR
from src.tools.search import web_search, _DESCRIPTOR as SEARCH_DESCRIPTOR
from src.tools.fetcher import web_read, _DESCRIPTOR as READ_DESCRIPTOR
from src.tools.calculator import calculator, DESCRIPTOR as CALC_DESCRIPTOR
from src.tools.knowledge import knowledge_search, _DESCRIPTOR as KNOWLEDGE_DESCRIPTOR
from src.tools.file_reader import file_read, _DESCRIPTOR as FILE_READ_DESCRIPTOR
from src.tools.memory_session import memory_session_search, _SESSION_DESCRIPTOR as SESSION_DESCRIPTOR
from src.tools.memory_user import memory_user_search, memory_user_save, _USER_SEARCH_DESCRIPTOR, _USER_SAVE_DESCRIPTOR


# ============ 工具注册表 ============

class ToolRegistry:
    """工具注册表 — 管理所有工具及其元数据"""

    def __init__(self):
        self._tools: dict[str, Any] = {}
        self._descriptors: dict[str, ToolDescriptor] = {}
        self._register_default_tools()

    def _register_default_tools(self) -> None:
        """注册默认工具集"""
        default_tools = [
            (get_weather, WEATHER_DESCRIPTOR),
            (web_search, SEARCH_DESCRIPTOR),
            (web_read, READ_DESCRIPTOR),
            (file_read, FILE_READ_DESCRIPTOR),
            (calculator, CALC_DESCRIPTOR),
            (knowledge_search, KNOWLEDGE_DESCRIPTOR),
            (memory_session_search, SESSION_DESCRIPTOR),
            (memory_user_search, _USER_SEARCH_DESCRIPTOR),
            (memory_user_save, _USER_SAVE_DESCRIPTOR),
        ]

        for tool_fn, descriptor in default_tools:
            self.register(tool_fn, descriptor)

    def register(self, tool_fn: Any, descriptor: ToolDescriptor) -> None:
        """注册一个工具"""
        self._tools[descriptor.name] = tool_fn
        self._descriptors[descriptor.name] = descriptor

    def get_descriptor(self, name: str) -> ToolDescriptor | None:
        """获取工具描述符"""
        return self._descriptors.get(name)

    def get_descriptors(self) -> list[ToolDescriptor]:
        """获取所有工具描述符"""
        return list(self._descriptors.values())

    def get_tool(self, name: str) -> Any | None:
        """获取工具函数"""
        return self._tools.get(name)

    def get_all_tools(self) -> list[Any]:
        """获取所有工具函数列表"""
        return list(self._tools.values())

    def get_visible_tools(self, user_permissions: list[str]) -> list[Any]:
        """
        根据用户权限返回可见工具列表。

        规则:
        - R0 工具（如 calculator）始终可见
        - R1+ 工具需要用户拥有对应权限
        - 如果用户权限为空，只返回 R0 工具
        """
        visible = []
        for name, tool_fn in self._tools.items():
            descriptor = self._descriptors[name]
            # R0 工具默认可见
            if descriptor.risk_level == "R0":
                visible.append(tool_fn)
                continue
            # 检查权限
            required = descriptor.required_permissions or []
            if not required:
                visible.append(tool_fn)
                continue
            # 用户拥有任一所需权限即可
            if any(perm in user_permissions for perm in required):
                visible.append(tool_fn)
        return visible

    def get_visible_descriptors(self, user_permissions: list[str]) -> list[dict[str, Any]]:
        """获取当前用户可见的工具元数据列表（用于 API 返回）"""
        result = []
        for descriptor in self._descriptors.values():
            if descriptor.risk_level == "R0":
                result.append({
                    "name": descriptor.name,
                    "title": descriptor.title,
                    "description": descriptor.description,
                    "category": descriptor.category,
                    "risk_level": descriptor.risk_level,
                    "available": True,
                })
                continue

            required = descriptor.required_permissions or []
            if not required or any(perm in user_permissions for perm in required):
                result.append({
                    "name": descriptor.name,
                    "title": descriptor.title,
                    "description": descriptor.description,
                    "category": descriptor.category,
                    "risk_level": descriptor.risk_level,
                    "available": True,
                })
            else:
                result.append({
                    "name": descriptor.name,
                    "title": descriptor.title,
                    "description": descriptor.description,
                    "category": descriptor.category,
                    "risk_level": descriptor.risk_level,
                    "available": False,
                })
        return result

    def get_categories(self) -> dict[str, list[dict[str, Any]]]:
        """按类别分组返回工具"""
        categories: dict[str, list[dict[str, Any]]] = {}
        for desc in self._descriptors.values():
            cat = desc.category
            if cat not in categories:
                categories[cat] = []
            categories[cat].append({
                "name": desc.name,
                "title": desc.title,
                "risk_level": desc.risk_level,
            })
        return categories


# ============ 全局单例 ============

_registry = ToolRegistry()


def get_registry() -> ToolRegistry:
    """获取全局注册表单例"""
    return _registry


def get_tools_for_user(user_permissions: list[str] | None = None) -> list[Any]:
    """根据用户权限获取可用工具列表（供 Agent 使用）"""
    if user_permissions is None:
        return _registry.get_all_tools()
    return _registry.get_visible_tools(user_permissions)


def get_tool_metadata_for_user(user_permissions: list[str] | None = None) -> list[dict[str, Any]]:
    """获取工具元数据（供 /tools API 使用）"""
    if user_permissions is None:
        user_permissions = []
    return _registry.get_visible_descriptors(user_permissions)
