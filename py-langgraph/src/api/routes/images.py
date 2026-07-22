import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from src.config.settings import settings

router = APIRouter()


class ImageGenerationRequest(BaseModel):
    prompt: str = Field(..., min_length=1, max_length=2000)


class ImageGenerationResponse(BaseModel):
    image_data_url: str


@router.post("/generations", response_model=ImageGenerationResponse)
async def generate_image(request: ImageGenerationRequest):
    if not settings.openai_api_key or not settings.openai_base_url:
        raise HTTPException(status_code=503, detail="Image model is not configured")

    image_url = f"{settings.openai_base_url.rstrip('/')}/images/generations"
    try:
        async with httpx.AsyncClient(timeout=60) as client:
            response = await client.post(
                image_url,
                headers={
                    "Authorization": f"Bearer {settings.openai_api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": settings.image_model,
                    "prompt": request.prompt,
                    "response_format": "b64_json",
                    "cfg_scale": 1.0,
                    "steps": 8,
                    "text_mode": True,
                },
            )
    except httpx.HTTPError as error:
        raise HTTPException(status_code=502, detail="Unable to reach the image service") from error

    payload = response.json() if response.content else {}
    if response.is_error:
        message = payload.get("error", {}).get("message", "Image generation failed")
        raise HTTPException(status_code=response.status_code, detail=message)

    image_data = payload.get("data", [])
    image_base64 = image_data[0].get("b64_json") if image_data else None
    if not image_base64:
        raise HTTPException(status_code=502, detail="Image service returned no image")

    return ImageGenerationResponse(image_data_url=f"data:image/png;base64,{image_base64}")
