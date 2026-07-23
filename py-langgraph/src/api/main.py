from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from .routes.v1 import router as v1_router
from .routes import chat, images, stream, tools
from src.services import BusinessError, BusinessErrorCode


def create_app() -> FastAPI:
    app = FastAPI(title="py-langgraph-agent", version="0.2.0")

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

    # 旧路由（保留兼容）
    app.include_router(chat.router, prefix="/chat", tags=["chat"])
    app.include_router(stream.router, prefix="/stream", tags=["stream"])
    app.include_router(tools.router, prefix="/tools", tags=["tools"])
    app.include_router(images.router, prefix="/images", tags=["images"])

    return app


app = create_app()
