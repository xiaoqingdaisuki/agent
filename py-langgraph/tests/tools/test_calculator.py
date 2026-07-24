"""
Tests for safe calculator — 验证安全表达式解析器
"""

import pytest
from src.tools.calculator import safe_calculate, calculator


class TestSafeCalculate:
    """安全计算器单元测试"""

    def test_basic_addition(self):
        assert safe_calculate("2 + 3") == 5

    def test_basic_subtraction(self):
        assert safe_calculate("10 - 4") == 6

    def test_basic_multiplication(self):
        assert safe_calculate("3 * 7") == 21

    def test_basic_division(self):
        assert safe_calculate("10 / 4") == 2.5

    def test_integer_division_result(self):
        result = safe_calculate("6 / 3")
        assert result == 2.0

    def test_modulo(self):
        assert safe_calculate("10 % 3") == 1

    def test_power(self):
        assert safe_calculate("2 ** 10") == 1024

    def test_caret_alias(self):
        assert safe_calculate("2 ^ 10") == 1024

    def test_parentheses(self):
        assert safe_calculate("(2 + 3) * 4") == 20

    def test_nested_parentheses(self):
        assert safe_calculate("((1 + 2) * 3) + 4") == 13

    def test_unary_minus(self):
        assert safe_calculate("-5 + 3") == -2

    def test_unary_plus(self):
        assert safe_calculate("+5 + 3") == 8

    def test_float_numbers(self):
        assert safe_calculate("3.14 + 2.86") == 6.0

    def test_spaces_ignored(self):
        assert safe_calculate(" 2 + 3 ") == 5

    def test_complex_expression(self):
        # (10 + 5) * 3 - 20 / 4 = 45 - 5 = 40
        assert safe_calculate("(10 + 5) * 3 - 20 / 4") == 40.0

    def test_division_by_zero_raises(self):
        with pytest.raises(Exception):
            safe_calculate("1 / 0")

    def test_modulo_by_zero_raises(self):
        with pytest.raises(Exception):
            safe_calculate("1 % 0")

    def test_mismatched_parens_raises(self):
        with pytest.raises(Exception):
            safe_calculate("(1 + 2")

    def test_extra_chars_raises(self):
        with pytest.raises(Exception):
            safe_calculate("2 + import os")

    def test_letters_rejected(self):
        with pytest.raises(Exception):
            safe_calculate("abc")

    def test_empty_raises(self):
        with pytest.raises(Exception):
            safe_calculate("")

    def test_function_call_rejected(self):
        with pytest.raises(Exception):
            safe_calculate("pow(2, 3)")

    def test_semicolon_rejected(self):
        with pytest.raises(Exception):
            safe_calculate("2; import os")


class TestCalculatorTool:
    """LangChain tool 封装测试"""

    def test_tool_returns_string(self):
        result = calculator.invoke({"expression": "2 + 2"})
        assert isinstance(result, str)
        assert "4" in result

    def test_tool_error_message(self):
        result = calculator.invoke({"expression": "1 / 0" })
        assert "错误" in result or "错误" in result

    def test_tool_rejects_code(self):
        result = calculator.invoke({"expression": "__import__('os').system('echo pwned')"})
        assert "错误" in result or "非法" in result
