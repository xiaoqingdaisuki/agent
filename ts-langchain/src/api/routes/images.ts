import type { FastifyInstance } from "fastify";

interface StepFunImageResponse {
  data?: Array<{ b64_json?: string }>;
  error?: { message?: string };
}

const MAX_IMAGE_REQUEST_ATTEMPTS = 3;

// 异步延迟辅助函数
function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// 带重试的图片生成请求，最多尝试 MAX_IMAGE_REQUEST_ATTEMPTS 次
async function requestImageGeneration(
  url: string,
  apiKey: string,
  prompt: string,
): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_IMAGE_REQUEST_ATTEMPTS; attempt++) {
    try {
      return await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: process.env.IMAGE_MODEL || "step-image-edit-2",
          prompt,
          response_format: "b64_json",
          cfg_scale: 1,
          steps: 8,
          text_mode: true,
        }),
      });
    } catch (error) {
      lastError = error;
      if (attempt < MAX_IMAGE_REQUEST_ATTEMPTS) await wait(attempt * 1000);
    }
  }

  throw lastError;
}

// 从环境变量拼接图片生成 API 的完整 URL
function getImageApiUrl(): string | null {
  const baseUrl = process.env.OPENAI_BASE_URL;
  if (!baseUrl) return null;

  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "https:") return null;
    return `${url.toString().replace(/\/$/, "")}/images/generations`;
  } catch {
    return null;
  }
}

// 创建或注册 registerImageRoutes 所需的数据
export async function registerImageRoutes(app: FastifyInstance) {
  app.post<{ Body: { prompt?: string } }>(
    "/images/generations",
    async (request, reply) => {
      const prompt = request.body?.prompt?.trim();
      if (!prompt || prompt.length > 2000) {
        return reply
          .status(400)
          .send({ error: "prompt must be between 1 and 2000 characters" });
      }

      const imageApiUrl = getImageApiUrl();
      const apiKey = process.env.OPENAI_API_KEY;
      if (!imageApiUrl || !apiKey) {
        return reply
          .status(503)
          .send({ error: "Image model is not configured" });
      }

      try {
        const response = await requestImageGeneration(
          imageApiUrl,
          apiKey,
          prompt,
        );
        const payload = (await response
          .json()
          .catch(() => null)) as StepFunImageResponse | null;

        if (!response.ok) {
          return reply
            .status(response.status)
            .send({
              error: payload?.error?.message || "Image generation failed",
            });
        }

        const imageBase64 = payload?.data?.[0]?.b64_json;
        if (!imageBase64) {
          return reply
            .status(502)
            .send({ error: "Image service returned no image" });
        }

        return { image_data_url: `data:image/png;base64,${imageBase64}` };
      } catch (error) {
        request.log.error(error, "Image generation request failed");
        return reply
          .status(502)
          .send({ error: "Unable to reach the image service" });
      }
    },
  );
}
