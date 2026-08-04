"""
file.read — 安全读取工作区文件

安全特性:
- 路径规范化：防止路径穿越 (../)
- 根目录约束：只能访问工作区内的文件
- 符号链接防逃逸：不跟随指向工作区外的 symlink
- 文件类型/大小白名单：限制可读文件类型和大小
- 编码检测：自动识别常见编码
- 分段读取：大文件支持 offset/limit 分页
- 敏感字段脱敏：检测常见密钥文件并脱敏
"""

from __future__ import annotations

import os
import re
from pathlib import Path
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

# ============ 安全限制 ============

# 允许的文件扩展名（小写）
ALLOWED_EXTENSIONS = {
    ".txt", ".md", ".json", ".yaml", ".yml", ".toml", ".ini", ".cfg",
    ".py", ".js", ".ts", ".java", ".go", ".rs", ".c", ".cpp", ".h",
    ".html", ".css", ".xml", ".csv", ".tsv", ".sql",
    ".sh", ".bash", ".zsh", ".bat", ".ps1",
    ".log", ".env.example", ".gitignore", ".dockerfile",
    ".license", ".readme",
}

# 禁止的文件名模式
_BLOCKED_FILENAMES = {
    ".env", ".env.local", ".env.production", ".env.dev",
    "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519",
    "*.pem", "*.key", "*.p12", "*.pfx",
}

# 最大文件大小（字节）— 1MB
MAX_FILE_SIZE = 1 * 1024 * 1024

# 单次读取最大字符数
MAX_READ_CHARS = 50_000

# 敏感内容模式（用于脱敏）
_SENSITIVE_PATTERNS = [
    (re.compile(r"(api[_-]?key|apikey)\s*[:=]\s*['\"]?([A-Za-z0-9_\-]{16,})['\"]?", re.IGNORECASE), "***REDACTED***"),
    (re.compile(r"(password|passwd|pwd)\s*[:=]\s*['\"]?([^'\"\s]{4,})['\"]?", re.IGNORECASE), "***REDACTED***"),
    (re.compile(r"(token|secret)\s*[:=]\s*['\"]?([A-Za-z0-9_\-\.]{16,})['\"]?", re.IGNORECASE), "***REDACTED***"),
    (
        re.compile(
            r"-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----[\s\S]*?"
            r"-----END\s+(?:RSA\s+)?PRIVATE\s+KEY-----",
            re.IGNORECASE,
        ),
        "***REDACTED***",
    ),
]


# ============ Tool Descriptor ============

_DESCRIPTOR = ToolDescriptor(
    name="file.read",
    version="1.0.0",
    title="文件读取",
    description="安全读取工作区内的指定文件内容。支持文本文件的读取，包括代码、配置、文档等。自动进行路径安全检查，防止访问工作区外的文件。大文件支持分段读取。",
    category="READ",
    risk_level="R1",
    side_effect="read",
    timeout_ms=10000,
    required_permissions=["file.read"],
    data_classification=["internal"],
    owner="tools",
    tags=["file", "read", "workspace"],
)


# ============ 安全路径解析 ============

# 安全解析文件路径，防止路径穿越和逃逸
def _resolve_safe_path(filepath: str, root_dir: str) -> tuple[Path | None, str | None]:
    """
    安全解析文件路径，防止路径穿越和逃逸。

    返回 (resolved_path, error_message)
    """
    # 规范化路径
    clean_path = filepath.strip()

    # 拒绝空路径
    if not clean_path:
        return None, "文件路径不能为空"

    candidate = Path(clean_path)
    if candidate.is_absolute() or candidate.drive or candidate.root:
        return None, "文件路径必须相对于工作区"

    # 检查是否包含路径穿越序列
    if ".." in clean_path.split("/") or ".." in clean_path.split("\\"):
        return None, "路径包含非法穿越序列 (..)"

    # 构建完整路径
    root = Path(root_dir).resolve()
    target = (root / clean_path).resolve()

    # 确保目标路径在根目录内
    try:
        target.relative_to(root)
    except ValueError:
        return None, f"文件路径超出工作区范围：{filepath}"

    return target, None


# 检查符号链接是否指向工作区外
def _check_symlink(path: Path) -> tuple[bool, str | None]:
    """检查符号链接是否指向工作区外"""
    if path.is_symlink():
        try:
            resolved = path.resolve()
            # 检查是否为文件
            if not resolved.is_file():
                return False, "符号链接指向非文件目标"
        except (OSError, RuntimeError):
            return False, "无法解析符号链接（可能指向循环链接）"
    return True, None


# 简单编码检测：依次尝试 UTF-8、GBK、Latin-1
def _detect_encoding(content: bytes) -> str:
    """简单编码检测"""
    # 尝试 UTF-8
    try:
        content.decode("utf-8")
        return "utf-8"
    except UnicodeDecodeError:
        pass

    # 尝试 GBK/GB2312
    try:
        content.decode("gbk")
        return "gbk"
    except UnicodeDecodeError:
        pass

    # 尝试 Latin-1
    try:
        content.decode("latin-1")
        return "latin-1"
    except UnicodeDecodeError:
        pass

    return "utf-8"  # fallback


# 对文件内容进行敏感信息脱敏处理
def _mask_sensitive(content: str) -> str:
    """对文件内容进行敏感信息脱敏"""
    masked = content
    for pattern, replacement in _SENSITIVE_PATTERNS:
        masked = pattern.sub(replacement, masked)
    return masked


# ============ LangChain Tool ============

class FileReadInput(BaseModel):
    filepath: str = Field(description="要读取的文件路径（相对于工作区），如 'README.md' 或 'src/main.py'")
    offset: int = Field(default=0, description="起始行号（从 0 开始），用于分段读取大文件", ge=0)
    limit: int = Field(default=100, description="最多读取行数，默认 100，最大 500", ge=1, le=500)


# 安全读取工作区内的指定文件，自动进行路径安全和脱敏检查
@tool(args_schema=FileReadInput)
def file_read(filepath: str, offset: int = 0, limit: int = 100) -> str:
    """安全读取工作区内的指定文件内容。自动进行路径安全检查，防止访问工作区外的文件。"""
    # 1. 路径安全检查
    root_dir = os.environ.get("AGENT_WORKSPACE_ROOT", ".")
    safe_path, error = _resolve_safe_path(filepath, root_dir)
    if not safe_path:
        return f"❌ 路径安全拒绝：{error}"

    # 2. 检查文件是否存在
    if not safe_path.exists():
        return f"❌ 文件不存在：{filepath}"

    # 3. 检查是否为文件（不是目录）
    if not safe_path.is_file():
        return f"❌ 路径不是文件：{filepath}"

    # 4. 检查符号链接
    symlink_ok, symlink_error = _check_symlink(safe_path)
    if not symlink_ok:
        return f"❌ 符号链接安全拒绝：{symlink_error}"

    # 5. 检查文件扩展名
    ext = safe_path.suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        return f"❌ 不支持的文件类型：{ext}（允许的类型：{', '.join(sorted(ALLOWED_EXTENSIONS))}）"

    # 6. 检查文件大小
    try:
        file_size = safe_path.stat().st_size
    except OSError:
        return f"❌ 无法访问文件：{filepath}"

    if file_size > MAX_FILE_SIZE:
        return f"❌ 文件过大（{file_size / 1024:.0f}KB），最大允许 {MAX_FILE_SIZE / 1024:.0f}KB"

    # 7. 读取文件内容
    try:
        raw_content = safe_path.read_bytes()
        encoding = _detect_encoding(raw_content)
        content = raw_content.decode(encoding, errors="replace")
    except OSError as e:
        return f"❌ 读取文件失败：{e}"
    except UnicodeDecodeError:
        return f"❌ 文件编码不支持：{filepath}"

    # 8. 敏感内容脱敏
    content = _mask_sensitive(content)

    # 9. 分段读取
    lines = content.splitlines()
    total_lines = len(lines)

    if offset > 0 and offset >= total_lines:
        return f"❌ 偏移量超出文件行数（共 {total_lines} 行）"

    end = min(offset + limit, total_lines)
    selected_lines = lines[offset:end]

    # 10. 构建返回
    header = f"📄 文件：{filepath}\n"
    header += f"编码：{encoding} | 大小：{file_size / 1024:.1f}KB | 行数：{total_lines}\n"

    if offset > 0 or end < total_lines:
        header += f"显示第 {offset + 1}-{end} 行（共 {total_lines} 行）\n"

    header += "─" * 40 + "\n\n"

    body = "\n".join(selected_lines)

    if end < total_lines:
        body += f"\n\n...（共 {total_lines} 行，已显示 {end} 行，剩余 {total_lines - end} 行未显示）"

    return header + body


# ============ 导出 ============

__all__ = ["ALLOWED_EXTENSIONS", "_DESCRIPTOR", "FileReadInput", "_resolve_safe_path", "file_read"]
