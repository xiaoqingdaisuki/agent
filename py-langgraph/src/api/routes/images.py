import asyncio
import random

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from src.config.settings import settings

router = APIRouter()


class ImageGenerationRequest(BaseModel):
    prompt: str = Field(..., min_length=1, max_length=2000)


class ImageGenerationResponse(BaseModel):
    image_data_url: str


MAX_IMAGE_REQUEST_ATTEMPTS = 3


# 调用需要 multipart 表单的 FLUX.2 模型接口，并在网络异常时重试。
async def _request_with_retry(url: str, api_key: str, prompt: str) -> httpx.Response:
    last_error: httpx.HTTPError | None = None
    for attempt in range(1, MAX_IMAGE_REQUEST_ATTEMPTS + 1):
        try:
            async with httpx.AsyncClient(timeout=60) as client:
                return await client.post(
                    url,
                    headers={"Authorization": f"Bearer {api_key}"},
                    files={
                        "prompt": (None, prompt),
                        "width": (None, "1024"),
                        "height": (None, "768"),
                    },
                )
        except httpx.HTTPError as exc:
            last_error = exc
            if attempt < MAX_IMAGE_REQUEST_ATTEMPTS:
                await asyncio.sleep(attempt + random.uniform(0, 1))

    raise last_error or RuntimeError("Image generation failed after retries")


# 从 Cloudflare 响应中提取可安全返回给调用方的错误信息。
def _get_error_message(payload: dict) -> str:
    errors = payload.get("errors") or []
    if errors and isinstance(errors[0], dict) and errors[0].get("message"):
        return str(errors[0]["message"])
    error = payload.get("error") or {}
    if isinstance(error, dict) and error.get("message"):
        return str(error["message"])
    return "Image generation failed"


@router.post("/generations", response_model=ImageGenerationResponse)
# 生成图片并将 Cloudflare 的 Base64 图片转为 data URL。
async def generate_image(request: ImageGenerationRequest):
    if not settings.image_api_key or not settings.image_base_url:
        raise HTTPException(status_code=503, detail="Image model is not configured")

    try:
        response = await _request_with_retry(
            f"{settings.image_base_url.rstrip('/')}/{settings.image_model}",
            settings.image_api_key,
            request.prompt,
        )
    except httpx.HTTPError:
        raise HTTPException(status_code=502, detail="Unable to reach the image service")

    try:
        payload = response.json() if response.content else {}
    except ValueError:
        payload = {}

    if response.is_error:
        raise HTTPException(status_code=response.status_code, detail=_get_error_message(payload))

    image_base64 = payload.get("result", {}).get("image")
    if not image_base64:
        raise HTTPException(status_code=502, detail=_get_error_message(payload))

    return ImageGenerationResponse(image_data_url=f"data:image/jpeg;base64,{image_base64}")
