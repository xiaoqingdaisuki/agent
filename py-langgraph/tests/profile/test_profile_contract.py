"""
Profile Contract Test — 验证现有内存实现的接口与 contracts/memory/models.schema.json 对齐
"""

import pytest
from src.profile.models import UserProfile, Memory, QARecord
from src.profile.service import ProfileService, MemoryService, HistoryService


class TestUserProfileContract:
    """验证 UserProfile 与 models.schema.json 的 UserProfile 定义对齐"""

    def test_has_required_fields(self):
        """UserProfile 必须包含所有必填字段"""
        profile = ProfileService.get_or_create("contract_user_1", "Alice")
        assert hasattr(profile, "id")
        assert hasattr(profile, "created_at")
        assert hasattr(profile, "last_active_at")
        assert isinstance(profile.id, str)
        assert isinstance(profile.created_at, str)
        assert isinstance(profile.last_active_at, str)

    def test_name_default_empty(self):
        """name 默认为空字符串"""
        profile = ProfileService.get_or_create("contract_user_2")
        assert profile.name == ""

    def test_update_updates_last_active(self):
        """update 会更新 last_active_at"""
        profile = ProfileService.get_or_create("contract_user_3", "Alice")
        original_ts = profile.last_active_at
        import time
        time.sleep(0.01)
        updated = ProfileService.update("contract_user_3")
        assert updated is not None
        assert updated.name == "Alice"
        assert updated.last_active_at != original_ts

    def test_to_dict_serialization(self):
        """to_dict 序列化包含全部字段"""
        profile = ProfileService.get_or_create("contract_user_4", "Bob")
        d = profile.to_dict()
        assert "id" in d
        assert "name" in d
        assert "preferences" in d
        assert "created_at" in d
        assert "last_active_at" in d


class TestMemoryContract:
    """验证 Memory 与 models.schema.json 的 Memory 定义对齐"""

    def test_has_all_required_fields(self):
        """Memory 必须包含所有必填字段"""
        mem = MemoryService.add("contract_user_5", "用户喜欢 Python", "preference", 4)
        assert hasattr(mem, "id")
        assert hasattr(mem, "user_id")
        assert hasattr(mem, "content")
        assert hasattr(mem, "category")
        assert hasattr(mem, "importance")
        assert hasattr(mem, "created_at")
        assert hasattr(mem, "updated_at")

    def test_category_is_valid_enum(self):
        """category 必须是四个有效值之一"""
        valid = {"preference", "fact", "decision", "context"}
        for cat in valid:
            mem = MemoryService.add("contract_user_6", f"test {cat}", cat, 3)
            assert mem.category in valid

    def test_importance_range(self):
        """importance 必须在 1-5 范围内"""
        for i in range(1, 6):
            mem = MemoryService.add("contract_user_7", f"imp {i}", "fact", i)
            assert mem.importance == i
            assert 1 <= mem.importance <= 5

    def test_importance_defaults_to_3(self):
        """importance 默认值为 3"""
        mem = MemoryService.add("contract_user_8", "default", "fact")
        assert mem.importance == 3

    def test_to_dict_serialization(self):
        """to_dict 序列化包含全部字段"""
        mem = MemoryService.add("contract_user_9", "test", "fact", 3)
        d = mem.to_dict()
        expected_keys = {"id", "user_id", "content", "category", "importance", "created_at", "updated_at"}
        assert expected_keys.issubset(d.keys())


class TestMemoryCRUD:
    """验证 Memory CRUD 操作符合 contracts 约定"""

    def test_add_then_get(self):
        """add 后可以通过 list_all 获取"""
        ProfileService.get_or_create("contract_user_10")
        MemoryService.add("contract_user_10", "可检索的记忆", "fact", 3)
        all_mems = MemoryService.list_all("contract_user_10")
        found = [m for m in all_mems if m["content"] == "可检索的记忆"]
        assert len(found) == 1

    def test_delete_removes_memory(self):
        """delete 后 list_all 返回空"""
        ProfileService.get_or_create("contract_user_11")
        mem = MemoryService.add("contract_user_11", "待删除", "fact", 3)
        result = MemoryService.delete("contract_user_11", mem.id)
        assert result is True
        assert len(MemoryService.list_all("contract_user_11")) == 0

    def test_delete_nonexistent_returns_false(self):
        """删除不存在的记忆返回 False"""
        ProfileService.get_or_create("contract_user_12")
        result = MemoryService.delete("contract_user_12", "nonexistent")
        assert result is False

    def test_get_by_category_filters(self):
        """get_by_category 按类别过滤"""
        ProfileService.get_or_create("contract_user_13")
        MemoryService.add("contract_user_13", "偏好A", "preference", 3)
        MemoryService.add("contract_user_13", "事实B", "fact", 3)
        prefs = MemoryService.get_by_category("contract_user_13", "preference")
        assert len(prefs) == 1
        assert prefs[0].content == "偏好A"

    def test_get_relevant_sorted_by_importance(self):
        """get_relevant 按重要性降序排列"""
        ProfileService.get_or_create("contract_user_14")
        MemoryService.add("contract_user_14", "低", "fact", 1)
        MemoryService.add("contract_user_14", "高", "fact", 5)
        MemoryService.add("contract_user_14", "中", "fact", 3)
        top2 = MemoryService.get_relevant("contract_user_14", 2)
        assert len(top2) == 2
        assert top2[0].importance >= top2[1].importance


class TestQARecordContract:
    """验证 QARecord 与 models.schema.json 约定对齐"""

    def test_has_required_fields(self):
        """QARecord 必须包含所有必填字段"""
        ProfileService.get_or_create("contract_user_15", "Eve")
        HistoryService.record("contract_user_15", "conv_1", "问题", "回答")
        history = HistoryService.get_history("contract_user_15", "conv_1")
        assert len(history) > 0
        rec = history[0]
        assert "id" in rec
        assert "user_id" in rec
        assert rec["conversation_id"] == "conv_1"
        assert rec["question"] == "问题"
        assert rec["answer"] == "回答"
        assert "timestamp" in rec

    def test_filters_by_conversation_id(self):
        """get_history 按 conversation_id 过滤"""
        ProfileService.get_or_create("contract_user_16")
        HistoryService.record("contract_user_16", "conv_A", "Q1", "A1")
        HistoryService.record("contract_user_16", "conv_B", "Q2", "A2")
        conv_a = HistoryService.get_history("contract_user_16", "conv_A")
        assert len(conv_a) == 1
        assert conv_a[0]["conversation_id"] == "conv_A"

    def test_respects_limit(self):
        """get_history 的 limit 参数生效"""
        ProfileService.get_or_create("contract_user_17")
        for i in range(10):
            HistoryService.record("contract_user_17", "conv_limit", f"Q{i}", f"A{i}")
        limited = HistoryService.get_history("contract_user_17", "conv_limit", 3)
        assert len(limited) == 3


class TestBuildMemoryContext:
    """验证 buildMemoryContext 输出符合 contracts 约定的格式"""

    def test_empty_when_no_memories(self):
        """无记忆时返回空字符串"""
        ProfileService.get_or_create("contract_user_18")
        ctx = MemoryService.build_memory_context("contract_user_18")
        assert ctx == ""

    def test_formats_with_header_and_bullets(self):
        """记忆以 [header] + bullet list 格式输出"""
        ProfileService.get_or_create("contract_user_19")
        MemoryService.add("contract_user_19", "用户在北京", "fact", 5)
        MemoryService.add("contract_user_19", "用户喜欢简洁", "preference", 4)
        ctx = MemoryService.build_memory_context("contract_user_19")
        assert "[我记住的关于你的事]" in ctx
        assert "用户在北京" in ctx
        assert "用户喜欢简洁" in ctx
