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
