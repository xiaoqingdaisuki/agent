"""健康检查与 readiness 状态。"""

from datetime import UTC, datetime

from src.config.settings import settings


# 汇总不含秘密的关键依赖配置状态，供 readiness 探针与编排器使用。
def get_readiness() -> dict:
    model_ready = bool(settings.openai_api_key or settings.anthropic_api_key)
    memory_ready = not settings.memory_enabled or bool(settings.memory_gateway_secret)
    ready = model_ready and memory_ready
    return {
        "status": "ok" if ready else "degraded",
        "ready": ready,
        "version": "0.2.0",
        "timestamp": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "components": {
            "model": "configured" if model_ready else "missing_configuration",
            "memory_gateway": "configured" if memory_ready else "missing_configuration",
        },
    }
