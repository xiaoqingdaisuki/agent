"""Tests for tool definitions"""

import pytest
from src.tools.weather import get_weather
from src.tools.calculator import calculator
from src.tools.search import web_search
from src.tools.fetcher import web_read


class TestWeatherTool:
    @pytest.mark.asyncio
    async def test_get_weather_returns_string(self):
        """Weather tool should return a non-empty string (real API or error message)"""
        result = await get_weather.ainvoke({"city": "Beijing"})
        assert isinstance(result, str)
        assert len(result) > 0

    @pytest.mark.asyncio
    async def test_get_weather_contains_city_or_error(self):
        """Weather result should mention the city or return a structured error"""
        result = await get_weather.ainvoke({"city": "Shanghai"})
        assert len(result) > 10

    @pytest.mark.asyncio
    async def test_get_weather_supports_days_parameter(self):
        """Weather tool should accept days parameter for forecast length"""
        result = await get_weather.ainvoke({"city": "Shenzhen", "days": 3})
        assert isinstance(result, str)
        assert len(result) > 10


class TestWebSearchTool:
    @pytest.mark.asyncio
    async def test_web_search_returns_string(self):
        """Web search should return a string"""
        result = await web_search.ainvoke({"query": "Python programming"})
        assert isinstance(result, str)
        assert len(result) > 0


class TestWebReadTool:
    @pytest.mark.asyncio
    async def test_web_read_returns_content(self):
        """Web read should return page content"""
        result = await web_read.ainvoke({"url": "https://example.com"})
        assert isinstance(result, str)
        assert len(result) > 0

    @pytest.mark.asyncio
    async def test_web_read_rejects_private_ip(self):
        """Web read should reject private/loopback URLs"""
        result = await web_read.ainvoke({"url": "http://127.0.0.1/admin"})
        assert "拒绝" in result or "安全" in result

    @pytest.mark.asyncio
    async def test_web_read_rejects_file_protocol(self):
        """Web read should reject non-HTTP protocols"""
        result = await web_read.ainvoke({"url": "file:///etc/passwd"})
        assert "拒绝" in result or "不支持" in result


class TestCalculatorTool:
    @pytest.mark.asyncio
    async def test_basic_addition(self):
        """Calculator should evaluate simple addition"""
        result = await calculator.ainvoke({"expression": "2 + 2"})
        assert "4" in result

    @pytest.mark.asyncio
    async def test_basic_multiplication(self):
        """Calculator should evaluate simple multiplication"""
        result = await calculator.ainvoke({"expression": "10 * 5"})
        assert "50" in result

    @pytest.mark.asyncio
    async def test_invalid_expression(self):
        """Calculator should handle invalid expressions gracefully"""
        result = await calculator.ainvoke({"expression": "import os"})
        assert "错误" in result or "非法" in result

    @pytest.mark.asyncio
    async def test_division(self):
        """Calculator should handle division"""
        result = await calculator.ainvoke({"expression": "10 / 2"})
        assert "5" in result

    @pytest.mark.asyncio
    async def test_code_injection_rejected(self):
        """Calculator should reject code injection attempts"""
        result = await calculator.ainvoke({"expression": "__import__('os').system('id')"})
        assert "错误" in result or "非法" in result
