"""Tests for tool definitions"""

import pytest
from src.tools import tools, get_weather, calculator


class TestToolRegistry:
    def test_tools_list_exists(self):
        """Should have tools list"""
        assert tools is not None
        assert len(tools) > 0

    def test_tools_list_contains_weather(self):
        """Should include weather tool"""
        tool_names = [t.name for t in tools]
        assert "get_weather" in tool_names

    def test_tools_list_contains_calculator(self):
        """Should include calculator tool"""
        tool_names = [t.name for t in tools]
        assert "calculator" in tool_names
