"""Shared test fixtures for py-langgraph tests"""

import pytest
import sys
import os

# Ensure src is importable
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))


@pytest.fixture
def mock_settings(monkeypatch):
    """Mock settings to avoid requiring real API keys"""
    import src.config.settings as settings_module
    monkeypatch.setattr(settings_module, "settings", settings_module.Settings(
        openai_api_key="test-key",
        openai_model="gpt-4o-mini",
        openai_base_url="https://api.openai.com/v1",
        image_model="step-image-edit-2",
        anthropic_api_key="test-anthropic-key",
        anthropic_model="claude-3-5-haiku-20241022",
        host="0.0.0.0",
        port=6002,
        postgres_uri="postgresql://test:test@localhost:5432/test",
        qdrant_url="http://localhost:6333",
    ))
