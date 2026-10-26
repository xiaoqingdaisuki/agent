"""验证内置工具定义与执行行为"""

import pytest
from src.tools.weather import get_weather
from src.tools.calculator import calculator
from src.tools.search import web_search
from src.tools.web_read import _is_safe_url, web_read


class TestWeatherTool:
    @pytest.mark.asyncio
    async def test_get_weather_returns_string(self):
        """验证天气工具返回非空字符串形式的 API 结果或错误消息"""
        result = await get_weather.ainvoke({"city": "Beijing"})
        assert isinstance(result, str)
        assert len(result) > 0

    @pytest.mark.asyncio
    async def test_get_weather_contains_city_or_error(self):
        """验证天气结果包含城市信息或返回结构化错误"""
        result = await get_weather.ainvoke({"city": "Shanghai"})
        assert len(result) > 10

    @pytest.mark.asyncio
    async def test_get_weather_supports_days_parameter(self):
        """验证天气工具接受 days 参数以指定预报天数"""
        result = await get_weather.ainvoke({"city": "Shenzhen", "days": 3})
        assert isinstance(result, str)
        assert len(result) > 10


class TestWebSearchTool:
    @pytest.mark.asyncio
    async def test_web_search_returns_string(self):
        """验证网页搜索返回字符串"""
        result = await web_search.ainvoke({"query": "Python programming"})
        assert isinstance(result, str)
        assert len(result) > 0


class TestWebReadTool:
    def test_rejects_hostname_resolving_to_private_ip(self, monkeypatch):
        import importlib

        web_read_module = importlib.import_module("src.tools.web_read")
        monkeypatch.setattr(
            web_read_module.socket,
            "getaddrinfo",
            lambda *args, **kwargs: [(2, 1, 6, "", ("10.0.0.8", 80))],
        )
        safe, reason = _is_safe_url("https://attacker.example/path")
        assert not safe
        assert "内网" in reason

    def test_rejects_credentials_in_url(self):
        safe, reason = _is_safe_url("https://user:password@example.com")
        assert not safe
        assert "用户名或密码" in reason

    @pytest.mark.asyncio
    async def test_web_read_returns_content(self):
        """验证网页读取返回页面内容"""
        result = await web_read.ainvoke({"url": "https://example.com"})
        assert isinstance(result, str)
        assert len(result) > 0

    @pytest.mark.asyncio
    async def test_web_read_rejects_private_ip(self):
        """验证网页读取拒绝私网及回环地址"""
        result = await web_read.ainvoke({"url": "http://127.0.0.1/admin"})
        assert "拒绝" in result or "安全" in result

    @pytest.mark.asyncio
    async def test_web_read_rejects_file_protocol(self):
        """验证网页读取拒绝非 HTTP 协议"""
        result = await web_read.ainvoke({"url": "file:///etc/passwd"})
        assert "拒绝" in result or "不支持" in result


class TestCalculatorTool:
    @pytest.mark.asyncio
    async def test_basic_addition(self):
        """验证计算器执行简单加法"""
        result = await calculator.ainvoke({"expression": "2 + 2"})
        assert "4" in result

    @pytest.mark.asyncio
    async def test_basic_multiplication(self):
        """验证计算器执行简单乘法"""
        result = await calculator.ainvoke({"expression": "10 * 5"})
        assert "50" in result

    @pytest.mark.asyncio
    async def test_invalid_expression(self):
        """验证计算器妥善处理非法表达式"""
        result = await calculator.ainvoke({"expression": "import os"})
        assert "错误" in result or "非法" in result

    @pytest.mark.asyncio
    async def test_division(self):
        """验证计算器执行除法"""
        result = await calculator.ainvoke({"expression": "10 / 2"})
        assert "5" in result

    @pytest.mark.asyncio
    async def test_code_injection_rejected(self):
        """验证计算器拒绝代码注入尝试"""
        result = await calculator.ainvoke({"expression": "__import__('os').system('id')"})
        assert "错误" in result or "非法" in result
