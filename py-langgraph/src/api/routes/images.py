import asyncio
import base64
import random

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from src.config.settings import settings

router = APIRouter()


class ImageGenerationRequest(BaseModel):
    prompt: str = Field(..., min_length=1)


class ImageGenerationResponse(BaseModel):
    image_data_url: str


MAX_IMAGE_REQUEST_ATTEMPTS = 3


# 调用图片模型接口，并在网络异常时重试。
async def _request_with_retry(url: str, api_key: str, prompt: str) -> httpx.Response:
    last_error: httpx.HTTPError | None = None
    uses_multipart = "/flux-2-" in settings.image_model
    for attempt in range(1, MAX_IMAGE_REQUEST_ATTEMPTS + 1):
        try:
            async with httpx.AsyncClient(timeout=90) as client:
                headers = {"Authorization": f"Bearer {api_key}"}
                if uses_multipart:
                    return await client.post(
                        url,
                        headers=headers,
                        files={
                            "prompt": (None, prompt),
                            "width": (None, "1024"),
                            "height": (None, "768"),
                        },
                    )
                return await client.post(
                    url,
                    headers=headers,
                    json={"prompt": prompt, "width": 1024, "height": 768, "num_steps": 4},
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
    prompt = request.prompt.strip()
    if not prompt or len(prompt) > 2000:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "INVALID_REQUEST",
                "message": "prompt must be between 1 and 2000 characters",
            },
        )
    if not settings.image_api_key or not settings.image_base_url:
        raise HTTPException(status_code=503, detail="Image model is not configured")

    try:
        response = await _request_with_retry(
            f"{settings.image_base_url.rstrip('/')}/{settings.image_model}",
            settings.image_api_key,
            prompt,
        )
    except httpx.HTTPError:
        raise HTTPException(status_code=502, detail="Unable to reach the image service")

    content_type = response.headers.get("content-type", "").split(";", 1)[0].lower()
    if response.is_success and content_type in {"image/png", "image/jpeg"}:
        if not response.content or len(response.content) > 10 * 1024 * 1024:
            raise HTTPException(status_code=502, detail="Invalid image response size")
        encoded = base64.b64encode(response.content).decode("ascii")
        return ImageGenerationResponse(image_data_url=f"data:{content_type};base64,{encoded}")

    try:
        payload = response.json() if response.content else {}
    except ValueError:
        payload = {}

    error_message = _get_error_message(payload)
    if response.is_error:
        if "4006:" in error_message or "daily free allocation" in error_message.lower():
            raise HTTPException(
                status_code=429,
                detail={
                    "code": "WORKERS_AI_QUOTA_EXHAUSTED",
                    "message": "Workers AI daily free quota exhausted; retry after the daily reset",
                },
            )
        raise HTTPException(status_code=response.status_code, detail=error_message)

    image_base64 = payload.get("result", {}).get("image")
    if not image_base64:
        raise HTTPException(status_code=502, detail=error_message)

    mime_type = "image/png" if str(image_base64).startswith("iVBOR") else "image/jpeg"
    return ImageGenerationResponse(image_data_url=f"data:{mime_type};base64,{image_base64}")
