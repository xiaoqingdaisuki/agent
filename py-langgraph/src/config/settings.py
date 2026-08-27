from pydantic import AliasChoices, Field, field_validator
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
    llm_max_retries: int = Field(default=1, ge=0, le=2)
    llm_max_context_tokens: int = Field(default=128000, ge=1024, le=128000)
    llm_max_input_tokens: int = Field(default=48000, ge=1024, le=48000)
    llm_max_output_tokens: int = Field(default=16000, ge=256, le=16000)
    history_context_token_budget: int = Field(default=48000, ge=1024, le=48000)
    llm_max_concurrency: int = Field(default=2, ge=1, le=32)
    llm_queue_max: int = Field(default=100, ge=1, le=1000)
    llm_queue_timeout_ms: int = Field(default=5000, ge=100, le=60000)
    background_task_concurrency: int = Field(default=4, ge=1, le=32)
    background_task_queue_max: int = Field(default=200, ge=1, le=1000)
    max_agent_iterations: int = 6
    react_max_steps: int = 8
    react_max_tool_calls: int = 6
    react_max_same_tool_calls: int = 3
    react_max_total_time_ms: int = 30000
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
    user_rate_limit_rpm: int = Field(default=120, ge=1, le=100000)
    tenant_rate_limit_rpm: int = Field(default=1200, ge=1, le=1000000)
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
    memory_auto_extract: bool = False
    memory_max_active_per_user: int = 50
    memory_request_timeout_ms: int = 15000

    @field_validator("openai_base_url")
    @classmethod
    # 规范化 OpenAI 兼容网关根地址，避免 SDK 请求根路径而得到 404。
    def normalize_openai_base_url(cls, value: str | None) -> str | None:
        if not value:
            return value
        normalized = value.rstrip("/")
        return f"{normalized}/v1" if "/" not in normalized.split("://", 1)[-1] else normalized

    model_config = SettingsConfigDict(env_file=".env", extra="ignore", populate_by_name=True)


settings = Settings()
