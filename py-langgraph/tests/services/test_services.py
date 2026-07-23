"""Tests for service layer"""

import pytest
from src.services import (
    BusinessError,
    BusinessErrorCode,
    ConversationService,
    Conversation,
)


class TestBusinessError:
    def test_create_error(self):
        """Should create error with code, message, and status"""
        err = BusinessError(BusinessErrorCode.NOT_FOUND, "Not found", 404)
        assert err.code == BusinessErrorCode.NOT_FOUND
        assert err.message == "Not found"
        assert err.status_code == 404

    def test_to_dict(self):
        """Should serialize to dict"""
        err = BusinessError(BusinessErrorCode.INVALID_REQUEST, "Bad request", 400)
        result = err.to_dict()
        assert result["error"]["code"] == BusinessErrorCode.INVALID_REQUEST.value
        assert result["error"]["message"] == "Bad request"

    def test_inherits_from_exception(self):
        """Should be catchable as Exception"""
        with pytest.raises(BusinessError):
            raise BusinessError(BusinessErrorCode.INTERNAL_ERROR, "Test error")


class TestConversationService:
    def test_create_conversation(self):
        """Should create a conversation with default mode"""
        conv = ConversationService.create("Test Chat")
        assert conv.title == "Test Chat"
        assert conv.mode == "chat"
        assert conv.id is not None
        assert conv.created_at is not None

    def test_create_conversation_with_mode(self):
        """Should create a conversation with custom mode"""
        conv = ConversationService.create("Knowledge Chat", mode="knowledge")
        assert conv.mode == "knowledge"

    def test_get_conversation(self):
        """Should retrieve a created conversation"""
        conv = ConversationService.create("Test")
        retrieved = ConversationService.get(conv.id)
        assert retrieved is not None
        assert retrieved.title == "Test"

    def test_get_nonexistent_conversation(self):
        """Should return None for non-existent conversation"""
        result = ConversationService.get("nonexistent_id")
        assert result is None

    def test_list_conversations(self):
        """Should list all conversations"""
        ConversationService.create("Conv 1")
        ConversationService.create("Conv 2")
        convs = ConversationService.list()
        assert len(convs) >= 2

    def test_delete_conversation(self):
        """Should delete a conversation"""
        conv = ConversationService.create("To Delete")
        result = ConversationService.delete(conv.id)
        assert result is True
        assert ConversationService.get(conv.id) is None

    def test_delete_nonexistent_conversation(self):
        """Should return False when deleting non-existent conversation"""
        result = ConversationService.delete("nonexistent_id")
        assert result is False

    def test_append_user_message(self):
        """Should append a user message to conversation"""
        conv = ConversationService.create("Test")
        initial_count = conv.message_count
        msg = ConversationService.append_user_message(conv.id, "Hello")
        assert msg.role == "user"
        assert msg.content == "Hello"
        assert conv.message_count == initial_count + 1

    def test_append_message_to_nonexistent_conversation(self):
        """Should raise error when appending to non-existent conversation"""
        with pytest.raises(BusinessError) as exc_info:
            ConversationService.append_user_message("nonexistent_id", "Hello")
        assert exc_info.value.code == BusinessErrorCode.NOT_FOUND
