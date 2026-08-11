import type { FastifyInstance } from "fastify";

import { config } from "../../config/index.js";

interface CloudflareImageResponse {
  result?: { image?: string };
  errors?: Array<{ message?: string }>;
  error?: { message?: string };
}

const MAX_IMAGE_REQUEST_ATTEMPTS = 3;

// 异步等待指定时长，用于请求重试的退避。
function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// 验证并拼接 Cloudflare Workers AI 模型运行接口地址。
function getImageApiUrl(): string | null {
  try {
    const url = new URL(config.IMAGE_BASE_URL);
    if (url.protocol !== "https:") return null;
    return `${url.toString().replace(/\/$/, "")}/${config.IMAGE_MODEL}`;
  } catch {
    return null;
  }
}

// 调用需要 multipart 表单的 FLUX.2 模型接口，并在网络异常时重试。
async function requestImageGeneration(
  url: string,
  apiKey: string,
  prompt: string,
): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_IMAGE_REQUEST_ATTEMPTS; attempt++) {
    try {
      const form = new FormData();
      form.append("prompt", prompt);
      form.append("width", "1024");
      form.append("height", "768");

      return await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        body: form,
      });
    } catch (error) {
      lastError = error;
      if (attempt < MAX_IMAGE_REQUEST_ATTEMPTS) await wait(attempt * 1000);
    }
  }

  throw lastError;
}

// 从 Cloudflare 响应中提取可安全返回给调用方的错误信息。
function getErrorMessage(payload: CloudflareImageResponse | null): string {
  return (
    payload?.errors?.[0]?.message ||
    payload?.error?.message ||
    "Image generation failed"
  );
}

// 注册文本生图接口，并将 Cloudflare 的 Base64 图片转为 data URL。
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
      if (!imageApiUrl || !config.IMAGE_API_KEY) {
        return reply
          .status(503)
          .send({ error: "Image model is not configured" });
      }

      try {
        const response = await requestImageGeneration(
          imageApiUrl,
          config.IMAGE_API_KEY,
          prompt,
        );
        const payload = (await response
          .json()
          .catch(() => null)) as CloudflareImageResponse | null;

        if (!response.ok) {
          return reply.status(response.status).send({ error: getErrorMessage(payload) });
        }

        const imageBase64 = payload?.result?.image;
        if (!imageBase64) {
          return reply.status(502).send({ error: getErrorMessage(payload) });
        }

        return { image_data_url: `data:image/jpeg;base64,${imageBase64}` };
      } catch (error) {
        request.log.error(error, "Image generation request failed");
        return reply
          .status(502)
          .send({ error: "Unable to reach the image service" });
      }
    },
  );
}
