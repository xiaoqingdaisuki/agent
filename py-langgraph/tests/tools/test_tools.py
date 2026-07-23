"""Tests for tool definitions"""

import pytest
from src.tools.weather import get_weather
from src.tools.calculator import calculator
from src.tools.search import web_search
from src.tools.fetcher import fetch_url


class TestWeatherTool:
    @pytest.mark.asyncio
    async def test_get_weather_returns_string(self):
        """Weather tool should return a non-empty string"""
        result = await get_weather.ainvoke({"city": "Beijing"})
        assert isinstance(result, str)
        assert len(result) > 0

    @pytest.mark.asyncio
    async def test_get_weather_contains_city_or_chinese_name(self):
        """Weather result should mention the city (English or Chinese)"""
        result = await get_weather.ainvoke({"city": "Shanghai"})
        assert "Shanghai" in result or "上海" in result

    @pytest.mark.asyncio
    async def test_get_weather_contains_temperature(self):
        """Weather result should contain temperature in Celsius"""
        result = await get_weather.ainvoke({"city": "Tokyo"})
        assert "°C" in result or "°" in result


class TestWebSearchTool:
    @pytest.mark.asyncio
    async def test_web_search_returns_string(self):
        """Web search should return a string"""
        result = await web_search.ainvoke({"query": "Python programming"})
        assert isinstance(result, str)
        assert len(result) > 0


class TestFetchUrlTool:
    @pytest.mark.asyncio
    async def test_fetch_url_returns_content(self):
        """Fetch URL should return page content"""
        result = await fetch_url.ainvoke({"url": "https://example.com" })
        assert isinstance(result, str)
        assert len(result) > 0


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
        assert "Error" in result

    @pytest.mark.asyncio
    async def test_division(self):
        """Calculator should handle division"""
        result = await calculator.ainvoke({"expression": "10 / 2"})
        assert "5" in result
