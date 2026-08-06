"""数据脱敏工具 — Python 版

两层保护：
  1. 结构化数据：按 key 名过滤敏感字段
  2. 内容级脱敏：对纯文本中的敏感值做正则替换
"""

from __future__ import annotations

import re

# ============ 结构化数据脱敏 ============

_SENSITIVE_KEYS = frozenset(
    [
        "api_key",
        "apikey",
        "secret",
        "password",
        "token",
        "access_token",
        "refresh_token",
        "private_key",
        "authorization",
        "credentials",
        "passwd",
        "pwd",
        "credential",
        "key",
        "cert",
        "cookie",
        "session_id",
        "csrf_token",
    ]
)


# 执行 redact structured data 对应的业务逻辑
def redact_structured_data(data):
    """对结构化数据递归脱敏 — 按 key 过滤 + 字符串值内容级脱敏。"""
    if data is None or isinstance(data, (bool, int, float)):
        return data

    if isinstance(data, str):
        return redact_text_content(data)

    if isinstance(data, list):
        return [redact_structured_data(item) for item in data]

    if isinstance(data, dict):
        result = {}
        for key, value in data.items():
            if key.lower() in _SENSITIVE_KEYS:
                result[key] = "[REDACTED]"
            elif isinstance(value, str):
                result[key] = redact_text_content(value)
            else:
                result[key] = redact_structured_data(value)
        return result

    return data


# ============ 内容级脱敏 ============

_CONTENT_REDACTION_RULES: list[tuple[str, re.Pattern, str]] = [
    # Bearer tokens
    (
        "bearer_token",
        re.compile(r"(Bearer\s+)[A-Za-z0-9\-._~+/]+=*", re.IGNORECASE),
        r"\1[REDACTED]",
    ),
    # Authorization headers
    (
        "auth_header",
        re.compile(r"(Authorization:\s*)[^\s,;]+", re.IGNORECASE),
        r"\1[REDACTED]",
    ),
    # Long hex strings (64+ chars) — likely API keys
    (
        "hex_api_key",
        re.compile(r"\b[a-f0-9]{64,}\b", re.IGNORECASE),
        "[REDACTED]",
    ),
    # JWT tokens
    (
        "jwt",
        re.compile(r"[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+"),
        "[REDACTED]",
    ),
    # Private keys
    (
        "private_key",
        re.compile(
            r"-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+Key-----"
            r"[\s\S]*?-----END\s+(?:RSA\s+)?PRIVATE\s+Key-----",
            re.IGNORECASE,
        ),
        "[REDACTED]",
    ),
    # AWS-style keys
    (
        "aws_key",
        re.compile(r"\b(AKIA|ASIA)[A-Z0-9]{16}\b"),
        "[REDACTED]",
    ),
    # Internal file paths
    (
        "server_path",
        re.compile(
            r"(?:[A-Za-z]:\\|/)(?:home|var|etc|usr|root|opt|app|deploy|srv|mnt)[/\\][^\s\"'<>]*",
            re.IGNORECASE,
        ),
        "[INTERNAL_PATH]",
    ),
    # Email addresses
    (
        "email",
        re.compile(r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b"),
        "[REDACTED_EMAIL]",
    ),
    # Internal IP ranges
    (
        "internal_ip",
        re.compile(
            r"\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}"
            r"|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}"
            r"|192\.168\.\d{1,3}\.\d{1,3})\b"
        ),
        "[REDACTED_IP]",
    ),
    # Inline password patterns
    (
        "password_inline",
        re.compile(
            r"(?:password|passwd|pwd|pass)\s*[=:]\s*[\"']?([^\s\"',;)}\]]+)[\"']?",
            re.IGNORECASE,
        ),
        r"\1=[REDACTED]",
    ),
]


# 执行 redact text content 对应的业务逻辑
def redact_text_content(text: str) -> str:
    """对纯文本内容做内容级脱敏。"""
    result = text
    for _name, pattern, replacement in _CONTENT_REDACTION_RULES:
        result = pattern.sub(replacement, result)
    return result


# 执行 redact data 对应的业务逻辑
def redact_data(data):
    """对任意类型数据做脱敏：结构化按 key 过滤 + 文本内容正则脱敏。"""
    if isinstance(data, str):
        return redact_text_content(data)
    return redact_structured_data(data)
