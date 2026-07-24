"""
Tests for file.read Tool
"""

import os
import tempfile
import pytest
from src.tools.file_reader import (
    file_read,
    _DESCRIPTOR,
    _resolve_safe_path,
    _detect_encoding,
    _mask_sensitive,
    ALLOWED_EXTENSIONS,
)


@pytest.fixture
def tmp_workspace(tmp_path, monkeypatch):
    """创建临时工作区，包含测试文件"""
    # 创建测试文件
    (tmp_path / "README.md").write_text("# Test Project\n\nThis is a test.")
    (tmp_path / "config.json").write_text('{"key": "value"}')
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "main.py").write_text("print('hello')\n" * 100)
    monkeypatch.setenv("AGENT_WORKSPACE_ROOT", str(tmp_path))
    return str(tmp_path)


class TestFileReadDescriptor:
    def test_name(self):
        assert _DESCRIPTOR.name == "file.read"

    def test_category(self):
        assert _DESCRIPTOR.category == "READ"

    def test_risk_level(self):
        assert _DESCRIPTOR.risk_level == "R1"

    def test_required_permissions(self):
        assert "file.read" in _DESCRIPTOR.required_permissions

    def test_timeout(self):
        assert _DESCRIPTOR.timeout_ms == 10000


class TestResolveSafePath:
    def test_normal_path(self):
        path, err = _resolve_safe_path("README.md", "/workspace")
        assert path is not None
        assert err is None

    def test_subdirectory(self):
        path, err = _resolve_safe_path("src/main.py", "/workspace")
        assert path is not None
        assert err is None

    def test_absolute_path_rejected(self):
        path, err = _resolve_safe_path("/README.md", "/workspace")
        assert path is None
        assert "相对于工作区" in err

    def test_empty_path(self):
        path, err = _resolve_safe_path("", "/workspace")
        assert path is None
        assert "不能为空" in err

    def test_path_traversal_rejected(self):
        path, err = _resolve_safe_path("../etc/passwd", "/workspace")
        assert path is None
        assert ".." in err or "穿越" in err

    def test_path_traversal_in_middle(self):
        path, err = _resolve_safe_path("src/../../etc/passwd", "/workspace")
        assert path is None


class TestDetectEncoding:
    def test_utf8(self):
        assert _detect_encoding("hello".encode("utf-8")) == "utf-8"

    def test_utf8_with_bom(self):
        assert _detect_encoding("﻿hello".encode("utf-8")) == "utf-8"

    def test_binary_fallback(self):
        # bytes(128-255) are not valid UTF-8, should fall through to latin-1
        assert _detect_encoding(bytes(range(128, 256))) == "latin-1"


class TestMaskSensitive:
    def test_api_key_masked(self):
        text = "api_key = 'abc12345678901234567890'"
        masked = _mask_sensitive(text)
        assert "abc12345678901234567890" not in masked
        assert "REDACTED" in masked

    def test_password_masked(self):
        text = "password = 'secret123'"
        masked = _mask_sensitive(text)
        assert "secret123" not in masked
        assert "REDACTED" in masked

    def test_normal_text_unchanged(self):
        text = "Hello world, this is normal text."
        assert _mask_sensitive(text) == text

    def test_private_key_block_masked(self):
        text = "-----BEGIN RSA PRIVATE KEY-----\ncontent\n-----END RSA PRIVATE KEY-----"
        masked = _mask_sensitive(text)
        assert "BEGIN RSA PRIVATE KEY" not in masked
        assert "REDACTED" in masked


class TestFileReadTool:
    @pytest.mark.asyncio
    async def test_read_markdown(self, tmp_workspace):
        result = await file_read.ainvoke({
            "filepath": "README.md",
        })
        assert "Test Project" in result
        assert "📄" in result

    @pytest.mark.asyncio
    async def test_read_json(self, tmp_workspace):
        result = await file_read.ainvoke({
            "filepath": "config.json",
        })
        assert "key" in result

    @pytest.mark.asyncio
    async def test_read_with_offset(self, tmp_workspace):
        result = await file_read.ainvoke({
            "filepath": "src/main.py",
            "offset": 0,
            "limit": 10,
        })
        assert "hello" in result

    @pytest.mark.asyncio
    async def test_nonexistent_file(self, tmp_workspace):
        result = await file_read.ainvoke({
            "filepath": "nonexistent.txt",
        })
        assert "不存在" in result

    @pytest.mark.asyncio
    async def test_blocked_extension(self, tmp_workspace):
        # 创建一个 .env 文件（不在允许列表中）
        env_path = os.path.join(tmp_workspace, ".env")
        with open(env_path, "w") as f:
            f.write("SECRET=value")
        result = await file_read.ainvoke({
            "filepath": ".env",
        })
        assert "不支持" in result
