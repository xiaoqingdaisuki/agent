import asyncio
import logging
from functools import wraps

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from src.config.settings import settings
from src.services import BusinessError, BusinessErrorCode

from .routes import chat, images, stream, tools
from .routes.v1 import router as v1_router

logger = logging.getLogger(__name__)

# 外层服务超时长于 Agent deadline，确保业务层先返回明确的 504。
DEFAULT_REQUEST_TIMEOUT = settings.server_request_timeout_ms / 1000


# 请求级超时中间件：非流式路由默认超时返回 504
async def _timeout_middleware(request: Request, call_next):
    """请求级超时中间件：非流式路由默认 60s 超时。"""
    path = request.url.path
    is_stream = path == "/stream" or path.endswith("/messages/stream")

    if is_stream:
        return await call_next(request)

    try:
        return await asyncio.wait_for(call_next(request), timeout=DEFAULT_REQUEST_TIMEOUT)
    except TimeoutError:
        logger.warning(
            "Request timeout: %s %s (%.1fs)", request.method, path, DEFAULT_REQUEST_TIMEOUT
        )
        return JSONResponse(
            status_code=504,
            content={
                "error": {
                    "code": BusinessErrorCode.SERVICE_UNAVAILABLE.value,
                    "message": "请求超时，请稍后重试",
                }
            },
        )


# 创建并配置 FastAPI 应用，注册所有路由和中间件
def create_app() -> FastAPI:
    app = FastAPI(title="py-langgraph-agent", version="0.2.0")

    allowed_origins = [
        origin.strip() for origin in settings.cors_origin.split(",") if origin.strip()
    ]
    if allowed_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=allowed_origins,
            allow_credentials="*" not in allowed_origins,
            allow_methods=["*"],
            allow_headers=["*"],
        )

    # 请求级超时中间件
    app.middleware("http")(_timeout_middleware)

    @app.exception_handler(BusinessError)
    async def business_error_handler(request: Request, exc: BusinessError):
        return JSONResponse(
            status_code=exc.status_code,
            content=exc.to_dict(),
        )

    @app.exception_handler(Exception)
    async def generic_error_handler(request: Request, exc: Exception):
        return JSONResponse(
            status_code=500,
            content={
                "error": {
                    "code": BusinessErrorCode.INTERNAL_ERROR.value,
                    "message": "Internal server error",
                }
            },
        )

    # External API v1（前端 UI 使用）
    app.include_router(v1_router, prefix="/api/v1", tags=["v1"])

    @app.get("/health")
    async def legacy_health():
        return {"status": "ok", "version": "0.2.0"}

    # 旧路由（保留兼容）
    app.include_router(chat.router, prefix="/chat", tags=["chat"])
    app.include_router(stream.router, prefix="/stream", tags=["stream"])
    app.include_router(tools.router, prefix="/tools", tags=["tools"])
    app.include_router(images.router, prefix="/images", tags=["images"])

    return app


app = create_app()


# 启动开发 API 服务器
def run() -> None:
    """Start the development API server through the ``agent`` console command."""
    import uvicorn

    uvicorn.run(
        "src.api.main:app",
        host=settings.host,
        port=settings.port,
        reload=True,
    )
