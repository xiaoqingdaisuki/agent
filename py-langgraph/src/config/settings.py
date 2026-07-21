from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    openai_api_key: str = ""
    openai_model: str = "gpt-4o-mini"
    anthropic_api_key: str = ""
    anthropic_model: str = "claude-3-5-haiku-20241022"
    host: str = "0.0.0.0"
    port: int = 3002
    postgres_uri: str = "postgresql://agent:agent@localhost:5432/agent"
    qdrant_url: str = "http://localhost:6333"

    class Config:
        env_file = ".env"


settings = Settings()
