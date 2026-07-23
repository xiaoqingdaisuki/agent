"""Tests for tool definitions"""

import pytest
from src.tools.weather import get_weather
from src.tools.calculator import calculator


class TestWeatherTool:
    @pytest.mark.asyncio
    async def test_get_weather_returns_string(self):
        """Weather tool should return a non-empty string"""
        result = await get_weather.ainvoke({"city": "Beijing"})
        assert isinstance(result, str)
        assert len(result) > 0

    @pytest.mark.asyncio
    async def test_get_weather_contains_city(self):
        """Weather result should mention the city"""
        result = await get_weather.ainvoke({"city": "Shanghai"})
        assert "Shanghai" in result

    @pytest.mark.asyncio
    async def test_get_weather_contains_temperature(self):
        """Weather result should contain temperature info"""
        result = await get_weather.ainvoke({"city": "Tokyo"})
        assert "°F" in result


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
