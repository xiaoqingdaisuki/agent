"""Tests for profile module"""

import pytest
from src.profile.models import UserProfile, Memory, QARecord, ProfileStore, store
from src.profile.service import ProfileService, MemoryService, HistoryService


class TestUserProfile:
    def test_create_profile(self):
        """Should create a user profile"""
        profile = ProfileService.get_or_create("user_1", "Alice")
        assert profile.id == "user_1"
        assert profile.name == "Alice"
        assert profile.preferences == {}

    def test_get_existing_profile(self):
        """Should return existing profile without overwriting"""
        ProfileService.get_or_create("user_2", "Bob")
        profile = ProfileService.get_or_create("user_2", "Charlie")
        assert profile.name == "Bob"  # name unchanged

    def test_update_profile(self):
        """Should update profile fields"""
        ProfileService.get_or_create("user_3")
        updated = ProfileService.update("user_3", name="UpdatedName", preferences={"style": "concise"})
        assert updated.name == "UpdatedName"
        assert updated.preferences["style"] == "concise"

    def test_update_nonexistent_profile(self):
        """Should return None when updating non-existent profile"""
        result = ProfileService.update("nonexistent", name="Test")
        assert result is None


class TestMemoryService:
    def test_add_memory(self):
        """Should add a memory"""
        ProfileService.get_or_create("user_4")
        memory = MemoryService.add("user_4", "用户喜欢简洁的回答", "preference", 4)
        assert memory.content == "用户喜欢简洁的回答"
        assert memory.category == "preference"
        assert memory.importance == 4

    def test_get_relevant_memories(self):
        """Should return memories sorted by importance"""
        ProfileService.get_or_create("user_5")
        MemoryService.add("user_5", "低优先级记忆", "fact", 1)
        MemoryService.add("user_5", "高优先级记忆", "fact", 5)
        MemoryService.add("user_5", "中优先级记忆", "fact", 3)

        memories = MemoryService.get_relevant("user_5")
        assert len(memories) == 3
        assert memories[0].importance >= memories[1].importance

    def test_get_by_category(self):
        """Should filter memories by category"""
        ProfileService.get_or_create("user_6")
        MemoryService.add("user_6", "偏好A", "preference", 3)
        MemoryService.add("user_6", "事实B", "fact", 3)

        prefs = MemoryService.get_by_category("user_6", "preference")
        assert len(prefs) == 1
        assert prefs[0].content == "偏好A"

    def test_delete_memory(self):
        """Should delete a memory"""
        ProfileService.get_or_create("user_7")
        memory = MemoryService.add("user_7", "要删除的记忆", "fact", 3)
        result = MemoryService.delete("user_7", memory.id)
        assert result is True
        assert len(MemoryService.list_all("user_7")) == 0

    def test_delete_nonexistent_memory(self):
        """Should return False when deleting non-existent memory"""
        ProfileService.get_or_create("user_8")
        result = MemoryService.delete("user_8", "nonexistent_id")
        assert result is False

    def test_build_memory_context_empty(self):
        """Should return empty string when no memories"""
        ProfileService.get_or_create("user_9")
        context = MemoryService.build_memory_context("user_9")
        assert context == ""

    def test_build_memory_context_with_memories(self):
        """Should format memories into context string"""
        ProfileService.get_or_create("user_10")
        MemoryService.add("user_10", "用户在北京", "fact", 5)
        MemoryService.add("user_10", "用户喜欢简洁回答", "preference", 4)

        context = MemoryService.build_memory_context("user_10")
        assert "[我记住的关于你的事]" in context
        assert "用户在北京" in context
        assert "用户喜欢简洁回答" in context


class TestMemoryExtraction:
    def test_extract_preference(self):
        """Should extract preference from user message"""
        ProfileService.get_or_create("user_11")
        memories = MemoryService.extract_memories_from_conversation(
            "user_11", "我喜欢简洁的回答", ""
        )
        assert len(memories) > 0
        assert any("偏好" in m.content for m in memories)

    def test_extract_location(self):
        """Should extract location info"""
        ProfileService.get_or_create("user_12")
        memories = MemoryService.extract_memories_from_conversation(
            "user_12", "我在北京", ""
        )
        assert len(memories) > 0
        assert any("北京" in m.content for m in memories)

    def test_no_extraction_for_regular_message(self):
        """Should not extract memories from regular messages"""
        ProfileService.get_or_create("user_13")
        initial_count = len(MemoryService.list_all("user_13"))
        MemoryService.extract_memories_from_conversation(
            "user_13", "今天天气怎么样", ""
        )
        assert len(MemoryService.list_all("user_13")) == initial_count


class TestHistoryService:
    def test_record_qa(self):
        """Should record a Q&A pair"""
        ProfileService.get_or_create("user_14")
        record = HistoryService.record("user_14", "conv_1", "你好", "你好呀！")
        assert record.question == "你好"
        assert record.answer == "你好呀！"
        assert record.conversation_id == "conv_1"

    def test_get_history(self):
        """Should retrieve Q&A history"""
        ProfileService.get_or_create("user_15")
        HistoryService.record("user_15", "conv_1", "Q1", "A1")
        HistoryService.record("user_15", "conv_1", "Q2", "A2")
        HistoryService.record("user_15", "conv_2", "Q3", "A3")

        history = HistoryService.get_history("user_15", "conv_1")
        assert len(history) == 2

        all_history = HistoryService.get_history("user_15")
        assert len(all_history) == 3
