from src.config.settings import Settings


def test_cloudflare_memory_environment_names_match_typescript(monkeypatch):
    monkeypatch.setenv("CLOUDFLARE_MEMORY_BASE_URL", "https://memory.example.com")
    monkeypatch.setenv("CLOUDFLARE_MEMORY_SECRET", "shared-secret")

    settings = Settings(_env_file=None)

    assert settings.memory_gateway_base_url == "https://memory.example.com"
    assert settings.memory_gateway_secret == "shared-secret"


def test_memory_gateway_legacy_environment_names_remain_compatible(monkeypatch):
    monkeypatch.delenv("CLOUDFLARE_MEMORY_BASE_URL", raising=False)
    monkeypatch.delenv("CLOUDFLARE_MEMORY_SECRET", raising=False)
    monkeypatch.setenv("MEMORY_GATEWAY_BASE_URL", "https://legacy.example.com")
    monkeypatch.setenv("MEMORY_GATEWAY_SECRET", "legacy-secret")

    settings = Settings(_env_file=None)

    assert settings.memory_gateway_base_url == "https://legacy.example.com"
    assert settings.memory_gateway_secret == "legacy-secret"


def test_memory_enabled_false_selects_llm_direct_mode(monkeypatch):
    monkeypatch.setenv("MEMORY_ENABLED", "false")

    settings = Settings(_env_file=None)

    assert settings.memory_enabled is False


def test_openai_gateway_root_is_normalized_to_v1():
    """OpenAI 兼容网关根地址应自动补齐 v1，和 TS 客户端保持一致。"""
    settings = Settings(_env_file=None, openai_base_url="https://llm.example.com")

    assert settings.openai_base_url == "https://llm.example.com/v1"


def test_memory_disabled_uses_singleton_in_memory_storage(monkeypatch):
    from langgraph.checkpoint.memory import MemorySaver
    import src.memory as memory_module
    import src.repositories as repositories_module
    from src.config.settings import settings

    monkeypatch.setattr(settings, "memory_enabled", False)
    monkeypatch.setattr(repositories_module, "_repositories", None)
    monkeypatch.setattr(memory_module, "_memory_saver", None)

    repositories = repositories_module.get_repositories()
    repositories.create_conversation("test-user", "内存会话", conversation_id="conv-memory")

    assert repositories.get_conversation("conv-memory") is not None
    assert isinstance(memory_module.get_default_checkpointer(), MemorySaver)
    assert memory_module.get_default_checkpointer() is memory_module.get_default_checkpointer()
