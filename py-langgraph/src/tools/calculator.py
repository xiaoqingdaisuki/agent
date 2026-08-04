"""
Safe Math Calculator — 使用手写 AST 解析器替代 eval()

支持: +, -, *, /, %, **, 括号, 一元负号
拒绝: 任意代码执行、函数调用、属性访问
"""

from __future__ import annotations

import re
from typing import Any

from langchain_core.tools import tool
from pydantic import BaseModel, Field

from src.tools.contracts import (
    ToolCategory,
    ToolDescriptor,
    ToolResultEnvelope,
    ToolResultMeta,
    SideEffect,
)


# ============ 安全表达式解析器 ============

_TOKEN_RE = re.compile(
    r"\s*(?:"
    r"(\d+(?:\.\d+)?)"           # 1: number
    r"|(\*\*)"                   # 2: power (must be before single *)
    r"|([+\-*/%])"               # 3: binary op
    r"|(\^)"                     # 4: caret (alias for power)
    r"|(\()"                     # 5: lparen
    r"|(\))"                     # 6: rparen
    r")\s*"
)


class _ParseError(Exception):
    pass


# 将数学表达式分解为 token 流
def _tokenize(expr: str) -> list[dict]:
    """将表达式分解为 token 流"""
    tokens: list[dict] = []
    pos = 0

    while pos < len(expr):
        m = _TOKEN_RE.match(expr, pos)
        if not m:
            raise _ParseError(f"无法解析的位置 {pos}: '{expr[pos:pos+20]}'")

        pos = m.end()

        if m.group(1) is not None:
            tokens.append({"type": "NUM", "value": float(m.group(1))})
        elif m.group(2) is not None:
            tokens.append({"type": "OP", "value": "**"})
        elif m.group(3) is not None:
            tokens.append({"type": "OP", "value": m.group(3)})
        elif m.group(4) is not None:
            tokens.append({"type": "OP", "value": "**"})
        elif m.group(5) is not None:
            tokens.append({"type": "LPAREN"})
        elif m.group(6) is not None:
            tokens.append({"type": "RPAREN"})

    return tokens


# 递归下降解析器：处理运算符优先级
def _eval_tokens(tokens: list[dict]) -> float:
    """递归下降解析器：处理运算符优先级"""

    def parse_expr(pos: int) -> tuple[float, int]:
        """处理 + 和 -（最低优先级）"""
        left, pos = parse_term(pos)

        while pos < len(tokens) and tokens[pos]["type"] == "OP" and tokens[pos]["value"] in ("+", "-"):
            op = tokens[pos]["value"]
            pos += 1
            right, pos = parse_term(pos)
            left = left + right if op == "+" else left - right

        return left, pos

    def parse_term(pos: int) -> tuple[float, int]:
        """处理 * / %"""
        left, pos = parse_factor(pos)

        while pos < len(tokens) and tokens[pos]["type"] == "OP" and tokens[pos]["value"] in ("*", "/", "%"):
            op = tokens[pos]["value"]
            pos += 1
            right, pos = parse_factor(pos)
            if op == "*":
                left = left * right
            elif op == "/":
                if right == 0:
                    raise _ParseError("除零错误")
                left = left / right
            elif op == "%":
                if right == 0:
                    raise _ParseError("取模除零")
                left = left % right

        return left, pos

    def parse_factor(pos: int) -> tuple[float, int]:
        """处理一元 +/- 和 **（幂运算）"""
        # 一元运算符
        if pos < len(tokens) and tokens[pos]["type"] == "OP" and tokens[pos]["value"] in ("+", "-"):
            op = tokens[pos]["value"]
            pos += 1
            value, pos = parse_factor(pos)
            return (value if op == "+" else -value), pos

        value, pos = parse_primary(pos)

        # 处理 **（右结合）
        while pos < len(tokens) and tokens[pos]["type"] == "OP" and tokens[pos]["value"] == "**":
            pos += 1
            # 右结合：右侧也是 factor
            exponent, pos = parse_factor(pos)
            try:
                value = value ** exponent
            except OverflowError:
                raise _ParseError("数值溢出")

        return value, pos

    def parse_primary(pos: int) -> tuple[float, int]:
        """处理数字和括号"""
        if pos >= len(tokens):
            raise _ParseError("表达式不完整，期望数字或左括号")

        token = tokens[pos]

        if token["type"] == "NUM":
            return token["value"], pos + 1

        if token["type"] == "LPAREN":
            pos += 1
            value, pos = parse_expr(pos)
            if pos >= len(tokens) or tokens[pos]["type"] != "RPAREN":
                raise _ParseError("缺少右括号 ')'")
            return value, pos + 1

        raise _ParseError(f"意外的 token: {token}")

    result, final_pos = parse_expr(0)
    if final_pos != len(tokens):
        raise _ParseError("表达式未完全解析，可能有多余字符")

    return result


def safe_calculate(expression: str) -> float:
    """
    安全计算数学表达式。

    只允许: 数字、+ - * / % ** ^、括号、空格
    """
    # 替换 ^ 为 **
    cleaned = expression.strip().replace("^", "**")
    # 字符白名单检查
    allowed = set("0123456789+-*/.()% \t\n")
    if not cleaned:
        raise _ParseError("空表达式")

    # 拒绝包含字母的表达式（防止函数调用）
    if re.search(r"[a-zA-Z_]", cleaned):
        raise _ParseError("表达式包含非法字符（字母、下划线等），仅支持纯数学运算")

    # 检查是否只包含允许的字符
    for ch in cleaned:
        if ch not in allowed:
            raise _ParseError(f"非法字符: '{ch}'")

    # 检查括号匹配
    depth = 0
    for ch in cleaned:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        if depth < 0:
            raise _ParseError("括号不匹配")

    if depth != 0:
        raise _ParseError("括号不匹配")

    # 替换 ^ 为 **
    cleaned = cleaned.replace("^", "**")

    tokens = _tokenize(cleaned)
    if not tokens:
        raise _ParseError("空表达式")

    result = _eval_tokens(tokens)

    # 检查结果是否合理
    import math
    if math.isnan(result) or math.isinf(result):
        raise _ParseError("计算结果不是有效数字")

    return result


# ============ LangChain Tool ============

class CalculatorInput(BaseModel):
    expression: str = Field(description="数学表达式，如 '2 + 2'、'(10 + 5) * 3'、'2 ** 10'")


DESCRIPTOR = ToolDescriptor(
    name="math.calculate",
    version="1.0.0",
    title="数学计算",
    description="安全计算数学表达式。支持四则运算、幂运算（**）、括号和取模（%）。只能做纯数学计算，不能执行代码或调用函数。",
    category="COMPUTE",
    risk_level="R0",
    side_effect="none",
    timeout_ms=5000,
    owner="tools",
    tags=["math", "compute"],
)


@tool(args_schema=CalculatorInput)
def calculator(expression: str) -> str:
    """安全计算数学表达式（四则运算、幂运算、括号）。"""
    try:
        result = safe_calculate(expression)
        # 如果是整数，去掉小数点
        if result == int(result):
            return f"计算结果：{int(result)}"
        return f"计算结果：{round(result, 10)}"
    except _ParseError as e:
        return f"表达式错误：{e}"
    except Exception as e:
        return f"计算错误：{e}"


# ============ 导出 ============

__all__ = ["DESCRIPTOR", "CalculatorInput", "calculator", "safe_calculate"]
