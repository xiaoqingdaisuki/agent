from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    openai_api_key: str = ""
    openai_model: str = "gpt-4o-mini"
    openai_base_url: str | None = None
    image_api_key: str = ""
    image_base_url: str = (
        "https://api.cloudflare.com/client/v4/accounts/572890169551ba29ece8e74c7b27c215/ai/run"
    )
    image_model: str = "@cf/black-forest-labs/flux-2-klein-9b"
    agent_deadline_ms: int = 120000
    agent_deadline_with_tools_ms: int = 300000
    server_request_timeout_ms: int = 310000
    llm_timeout_ms: int = 30000
    llm_max_retries: int = 1
    max_agent_iterations: int = 6
    anthropic_api_key: str = ""
    anthropic_model: str = "claude-3-5-haiku-20241022"
    tavily_api_key: str = ""
    tavily_search_depth: str = "basic"
    search_timeout_ms: int = 4500
    search_max_attempts: int = 1
    search_max_results: int = 8
    search_cache_ttl_seconds: int = 30
    search_stale_ttl_seconds: int = 600
    host: str = "0.0.0.0"
    port: int = 6002
    agent_api_secret: str = ""
    cors_origin: str = ""

    # ============ Cloudflare Service 配置 ============
    memory_enabled: bool = True
    memory_gateway_base_url: str = Field(
        default="http://localhost:8787",
        validation_alias=AliasChoices(
            "CLOUDFLARE_MEMORY_BASE_URL",
            "MEMORY_GATEWAY_BASE_URL",
        ),
    )
    memory_gateway_secret: str = Field(
        default="",
        validation_alias=AliasChoices(
            "CLOUDFLARE_MEMORY_SECRET",
            "MEMORY_GATEWAY_SECRET",
        ),
    )
    memory_search_mode: str = "hybrid"
    memory_auto_extract: bool = True
    memory_max_active_per_user: int = 50
    memory_request_timeout_ms: int = 5000

    model_config = SettingsConfigDict(env_file=".env", extra="ignore", populate_by_name=True)


settings = Settings()
