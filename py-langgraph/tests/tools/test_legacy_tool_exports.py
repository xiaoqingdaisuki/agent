"""验证内置工具定义与执行行为"""

import pytest
from src.tools import tools, get_weather, calculator


class TestToolRegistry:
    def test_tools_list_exists(self):
        """验证导出工具列表"""
        assert tools is not None
        assert len(tools) > 0

    def test_tools_list_contains_weather(self):
        """验证列表包含天气工具"""
        tool_names = [t.name for t in tools]
        assert "get_weather" in tool_names

    def test_tools_list_contains_calculator(self):
        """验证列表包含计算器工具"""
        tool_names = [t.name for t in tools]
        assert "calculator" in tool_names
