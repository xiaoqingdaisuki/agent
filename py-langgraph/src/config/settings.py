from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    openai_api_key: str = ""
    openai_model: str = "gpt-4o-mini"
    openai_base_url: str | None = None
    image_model: str = "step-image-edit-2"
    agent_deadline_ms: int = 30000
    agent_deadline_with_tools_ms: int = 90000
    server_request_timeout_ms: int = 100000
    llm_timeout_ms: int = 12000
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
    cors_origin: str = ""
    postgres_uri: str = "postgresql://agent:agent@localhost:5432/agent"
    qdrant_url: str = "http://localhost:6333"

    model_config = SettingsConfigDict(env_file=".env")


settings = Settings()
