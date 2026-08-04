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


# 带重试的图片生成请求，退避时间带随机抖动避免惊群
async def _request_with_retry(
    url: str, api_key: str, prompt: str
) -> httpx.Response:
    """带重试的图片生成请求，退避时间带随机抖动避免惊群。"""
    last_error: Exception | None = None
    for attempt in range(1, MAX_IMAGE_REQUEST_ATTEMPTS + 1):
        try:
            async with httpx.AsyncClient(timeout=60) as client:
                return await client.post(
                    url,
                    headers={
                        "Authorization": f"Bearer {api_key}",
                        "Content-Type": "application/json",
                    },
                    json={
                        "model": settings.image_model,
                        "prompt": prompt,
                        "response_format": "b64_json",
                        "cfg_scale": 1.0,
                        "steps": 8,
                        "text_mode": True,
                    },
                )
        except httpx.HTTPError as exc:
            last_error = exc
            if attempt < MAX_IMAGE_REQUEST_ATTEMPTS:
                # 退避 1s, 2s + 随机抖动
                await asyncio.sleep(attempt + random.uniform(0, 1))

    raise last_error or RuntimeError("Image generation failed after retries")


# 生成图片并返回 base64 编码的 data URL
@router.post("/generations", response_model=ImageGenerationResponse)
async def generate_image(request: ImageGenerationRequest):
    if not settings.openai_api_key or not settings.openai_base_url:
        raise HTTPException(status_code=503, detail="Image model is not configured")

    image_url = f"{settings.openai_base_url.rstrip('/')}/images/generations"

    try:
        response = await _request_with_retry(image_url, settings.openai_api_key, request.prompt)
    except httpx.HTTPError:
        raise HTTPException(status_code=502, detail="Unable to reach the image service")

    payload = response.json() if response.content else {}
    if response.is_error:
        message = payload.get("error", {}).get("message", "Image generation failed")
        raise HTTPException(status_code=response.status_code, detail=message)

    image_data = payload.get("data", [])
    image_base64 = image_data[0].get("b64_json") if image_data else None
    if not image_base64:
        raise HTTPException(status_code=502, detail="Image service returned no image")

    return ImageGenerationResponse(image_data_url=f"data:image/png;base64,{image_base64}")
