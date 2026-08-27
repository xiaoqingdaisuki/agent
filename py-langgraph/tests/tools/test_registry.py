"""
Tests for Tool Registry — 验证工具注册、动态裁剪
"""

import pytest
from src.tools.registry import ToolRegistry, get_registry, get_tools_for_user, get_tool_metadata_for_user
from src.tools.contracts import ToolDescriptor, ToolCategory, SideEffect, RiskLevel


@pytest.fixture
def registry():
    """创建一个带自定义工具的测试注册表"""
    reg = ToolRegistry()

    # 添加一个 R0 工具（无权限要求）
    def calc_fn(x):
        return x * 2

    calc_desc = ToolDescriptor(
        name="test.calculate", version="1.0.0", title="Test Calc",
        description="test", category="COMPUTE",
        risk_level="R0", side_effect="none", timeout_ms=5000,
    )
    reg.register(calc_fn, calc_desc)

    # 添加一个 R2 工具（需要权限）
    def write_fn(x):
        return x

    write_desc = ToolDescriptor(
        name="test.write", version="1.0.0", title="Test Write",
        description="test", category="ACTION",
        risk_level="R2", side_effect="write", timeout_ms=5000,
        required_permissions=["test.write"],
    )
    reg.register(write_fn, write_desc)

    return reg


class TestToolRegistry:
    def test_get_descriptor(self, registry):
        desc = registry.get_descriptor("test.calculate")
        assert desc is not None
        assert desc.name == "test.calculate"
        assert desc.risk_level == "R0"

    def test_get_descriptor_not_found(self, registry):
        assert registry.get_descriptor("nonexistent") is None

    def test_get_all_descriptors(self, registry):
        descs = registry.get_descriptors()
        # 默认 4 个 + 2 个测试工具 = 6
        assert len(descs) >= 6

    def test_r0_visible_without_permissions(self, registry):
        tools = registry.get_visible_tools([])
        # R0 tools should be visible without any permissions
        assert len(tools) >= 1  # test.calculate

    def test_r2_hidden_without_permissions(self, registry):
        # test.write should be in the list but marked unavailable
        descs = registry.get_visible_descriptors([])
        desc_map = {d["name"]: d for d in descs}
        assert "test.write" in desc_map
        assert desc_map["test.write"]["available"] is False

    def test_r2_visible_with_permissions(self, registry):
        descs = registry.get_visible_descriptors(["test.write"])
        desc_map = {d["name"]: d for d in descs}
        assert "test.write" in desc_map
        assert desc_map["test.write"]["available"] is True

    def test_metadata_structure(self, registry):
        descs = registry.get_visible_descriptors([])
        for desc in descs:
            assert "name" in desc
            assert "title" in desc
            assert "description" in desc
            assert "category" in desc
            assert "risk_level" in desc
            assert "available" in desc

    def test_categories_grouping(self, registry):
        cats = registry.get_categories()
        assert "COMPUTE" in cats
        assert "READ" in cats
        assert "SEARCH" in cats


class TestGlobalRegistry:
    def test_get_registry_singleton(self):
        r1 = get_registry()
        r2 = get_registry()
        assert r1 is r2

    def test_get_tools_for_user_default(self):
        tools = get_tools_for_user()
        assert len(tools) >= 4  # 默认注册了 4 个工具
        names = {tool.name for tool in tools}
        assert "memory_user_save" not in names
        assert "memory_user_delete" not in names

    def test_get_tool_metadata_default(self):
        meta = get_tool_metadata_for_user()
        assert len(meta) >= 4
        names = [m["name"] for m in meta]
        assert "math.calculate" in names
        assert "web.search" in names
        assert "web.read" in names
