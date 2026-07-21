from fastapi import FastAPI
from .routes.v1 import router as v1_router
from .routes.internal import router as internal_router
from .routes import chat, stream, tools


def create_app() -> FastAPI:
    app = FastAPI(title="py-langgraph-agent", version="0.2.0")

    # External API v1（前端 UI 使用）
    app.include_router(v1_router, prefix="/api/v1", tags=["v1"])

    # Internal API（QQ Bot 使用）
    app.include_router(internal_router, prefix="/api/internal", tags=["internal"])

    # 旧路由（保留兼容）
    app.include_router(chat.router, prefix="/chat", tags=["chat"])
    app.include_router(stream.router, prefix="/stream", tags=["stream"])
    app.include_router(tools.router, prefix="/tools", tags=["tools"])

    return app


app = create_app()
