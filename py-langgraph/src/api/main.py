import asyncio
import logging
from contextlib import asynccontextmanager
from functools import wraps

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.encoders import jsonable_encoder
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from src.config.settings import settings
from src.services import BusinessError, BusinessErrorCode
from src.api.request_logging import log_request_error

from .auth import agent_auth_middleware
from .routes import chat, images, stream, tools
from .routes.v1 import router as v1_router

logger = logging.getLogger(__name__)

# 外层服务超时长于 Agent deadline，确保业务层先返回明确的 504。
DEFAULT_REQUEST_TIMEOUT = settings.server_request_timeout_ms / 1000


@asynccontextmanager
# 在应用关闭时收敛后台持久化任务并释放共享网关连接。
async def _lifespan(_app: FastAPI):
    yield
    from src.repositories import close_repositories
    from src.services import flush_background_tasks

    try:
        await asyncio.wait_for(flush_background_tasks(), timeout=10)
    finally:
        await close_repositories()


# 请求级超时中间件：非流式路由默认超时返回 504
async def _timeout_middleware(request: Request, call_next):
    """请求级超时中间件：非流式路由使用服务端配置的外层超时。"""
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
    app = FastAPI(title="py-langgraph-agent", version="0.2.0", lifespan=_lifespan)

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
    app.middleware("http")(agent_auth_middleware)

    @app.exception_handler(BusinessError)
    # 执行 business error handler 对应的业务逻辑
    async def business_error_handler(request: Request, exc: BusinessError):
        log_request_error(request, exc)
        return JSONResponse(
            status_code=exc.status_code,
            content=exc.to_dict(),
        )

    @app.exception_handler(HTTPException)
    # 记录非预期 HTTP 500，并保留路由转换前的原始异常上下文
    async def http_error_handler(request: Request, exc: HTTPException):
        if exc.status_code >= 500 and not getattr(
            request.state, "request_error_logged", False
        ):
            original_error = exc.__context__ if isinstance(exc.__context__, BaseException) else exc
            log_request_error(
                request,
                original_error,
                {"status_code": exc.status_code, "http_exception": True},
            )
        detail = exc.detail if isinstance(exc.detail, dict) else {}
        nested_error = detail.get("error")
        if isinstance(nested_error, dict):
            detail = nested_error
        error = {
            "code": str(detail.get("code") or f"HTTP_{exc.status_code}"),
            "message": str(detail.get("message") or exc.detail or "请求失败"),
        }
        if detail.get("details") is not None:
            error["details"] = detail["details"]
        return JSONResponse(status_code=exc.status_code, content={"error": error}, headers=exc.headers)

    @app.exception_handler(RequestValidationError)
    # 记录与 TS 全局错误处理器一致的请求校验异常和请求上下文
    async def validation_error_handler(request: Request, exc: RequestValidationError):
        log_request_error(
            request,
            exc,
            {"status_code": 422, "validation_errors": jsonable_encoder(exc.errors())},
        )
        return JSONResponse(
            status_code=400,
            content={
                "error": {
                    "code": "VALIDATION_ERROR",
                    "message": "请求参数无效",
                    "details": {"fields": jsonable_encoder(exc.errors())},
                }
            },
        )

    @app.exception_handler(Exception)
    # 执行 generic error handler 对应的业务逻辑
    async def generic_error_handler(request: Request, exc: Exception):
        log_request_error(request, exc)
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
    # 执行 legacy health 对应的业务逻辑
    async def legacy_health():
        return {"status": "ok", "version": "0.2.0"}

    @app.get("/health/live")
    # 报告进程存活，不依赖外部服务。
    async def live_health():
        return {"status": "ok", "live": True, "version": "0.2.0"}

    @app.get("/health/ready")
    # 报告关键依赖配置是否满足接流条件。
    async def ready_health():
        from fastapi.responses import JSONResponse
        from src.api.health import get_readiness

        readiness = get_readiness()
        return JSONResponse(status_code=200 if readiness["ready"] else 503, content=readiness)

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
