import type { FastifyInstance } from "fastify";

import { config } from "../../config/index.js";
import { generateBoundImage } from "../../runtime.js";

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

// 按模型选择 JSON 或 multipart 请求，并限制上游生图等待时间。
async function requestImageGeneration(
  url: string,
  apiKey: string,
  prompt: string,
): Promise<Response> {
  const usesMultipart = config.IMAGE_MODEL.includes("/flux-2-");
  const form = new FormData();
  if (usesMultipart) {
    form.append("prompt", prompt);
    form.append("width", "1024");
    form.append("height", "768");
  }
  const input = usesMultipart ? form : { prompt, width: 1024, height: 768, num_steps: 4 };
  const boundResponse = generateBoundImage(config.IMAGE_MODEL, input);
  if (boundResponse) return await boundResponse;
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_IMAGE_REQUEST_ATTEMPTS; attempt++) {
    try {
      return await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          ...(!usesMultipart ? { "Content-Type": "application/json" } : {}),
          ...(config.CLOUDFLARE_AI_GATEWAY_TOKEN && url.startsWith("https://gateway.ai.cloudflare.com/")
            ? { "cf-aig-authorization": `Bearer ${config.CLOUDFLARE_AI_GATEWAY_TOKEN}` }
            : {}),
        },
        body: usesMultipart ? form : JSON.stringify(input),
        signal: AbortSignal.timeout(90_000),
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
        const imageType = response.headers.get("Content-Type")?.split(";", 1)[0];
        if (response.ok && (imageType === "image/png" || imageType === "image/jpeg")) {
          const bytes = Buffer.from(await response.arrayBuffer());
          if (bytes.length === 0 || bytes.length > 10 * 1024 * 1024) {
            return reply.status(502).send({ error: "Invalid image response size" });
          }
          return { image_data_url: `data:${imageType};base64,${bytes.toString("base64")}` };
        }
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

        const mimeType = imageBase64.startsWith("iVBOR") ? "image/png" : "image/jpeg";
        return { image_data_url: `data:${mimeType};base64,${imageBase64}` };
      } catch (error) {
        if (error instanceof Error && /4006:|daily free allocation/i.test(error.message)) {
          return reply.status(429).send({
            error: "Workers AI daily free quota exhausted; retry after the daily reset",
            code: "WORKERS_AI_QUOTA_EXHAUSTED",
          });
        }
        request.log.error(error, "Image generation request failed");
        return reply
          .status(502)
          .send({ error: "Unable to reach the image service" });
      }
    },
  );
}
