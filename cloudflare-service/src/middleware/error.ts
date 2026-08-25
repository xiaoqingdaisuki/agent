/**
 * 统一错误处理中间件
 *
 * 将内部错误映射为 Gateway 统一响应格式：
 * { ok: false, error: { code, message }, meta: { request_id, degraded, warnings } }
 *
 * 注意：Hono 4 的 onError 处理器中 c.json() 不可用，
 * 必须返回原生 Response 对象。
 */

import { HTTPException } from "hono/http-exception";

// D1 错误码映射
const D1_ERROR_MAP: Record<string, string> = {
  "SQLITE_CONSTRAINT_UNIQUE": "MEMORY_CONFLICT",
  "SQLITE_CONSTRAINT_CHECK": "MEMORY_INVALID_REQUEST",
  "SQLITE_CONSTRAINT_FOREIGNKEY": "MEMORY_INVALID_REQUEST",
};

// Vectorize 错误识别
function isVectorizeError(error: any): boolean {
  return error?.message?.includes("Vectorize") || error?.message?.includes("vectorize");
}

// Workers AI 错误识别
function isAIError(error: any): boolean {
  const message = String(error?.message ?? "").toLowerCase();
  return (
    message.includes("workers ai") ||
    message.includes("workers-ai") ||
    message.includes("ai binding") ||
    message.includes("ai.run") ||
    message.includes("embedding")
  );
}

// 从 D1 顶层、cause 或错误消息中识别约束错误码
function getD1ErrorCode(error: any): string | undefined {
  const candidates = [error?.code, error?.cause?.code];
  for (const code of candidates) {
    if (typeof code === "string" && D1_ERROR_MAP[code]) return code;
  }
  const message = String(error?.message ?? "");
  return Object.keys(D1_ERROR_MAP).find((code) => message.includes(code));
}

// 构建 JSON 响应
function jsonResponse(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// 默认错误处理器 — Hono 4 兼容（参数顺序: error, context）
export function errorHandler(error: any, c: any) {
  const requestId = c.get?.("requestId") || `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const warnings: string[] = [];

  // HTTPException — Hono 原生异常
  if (error instanceof HTTPException) {
    return jsonResponse(
      {
        ok: false,
        data: null,
        error: { code: "MEMORY_INVALID_REQUEST", message: error.message },
        meta: { request_id: requestId },
      },
      error.status,
    );
  }

  // Zod 请求校验失败应返回客户端参数错误，而不是误报为存储服务故障。
  if (error?.name === "ZodError" || Array.isArray(error?.issues)) {
    return jsonResponse(
      {
        ok: false,
        data: null,
        error: { code: "MEMORY_INVALID_REQUEST", message: "请求参数校验失败" },
        meta: { request_id: requestId },
      },
      400,
    );
  }

  // D1 错误
  const d1ErrorCode = getD1ErrorCode(error);
  if (d1ErrorCode) {
    const code = D1_ERROR_MAP[d1ErrorCode];
    return jsonResponse(
      {
        ok: false,
        data: null,
        error: { code, message: error.message || "数据约束冲突" },
        meta: { request_id: requestId },
      },
      409,
    );
  }

  // Vectorize 不可用 — 返回降级响应
  if (isVectorizeError(error)) {
    warnings.push("Vectorize unavailable, degraded to SQL");
    return jsonResponse(
      {
        ok: false,
        data: null,
        error: { code: "MEMORY_VECTORIZE_UNAVAILABLE", message: "向量索引服务不可用" },
        meta: { request_id: requestId, degraded: true, warnings },
      },
      503,
    );
  }

  // Workers AI 不可用
  if (isAIError(error)) {
    warnings.push("Embedding service unavailable, degraded to SQL");
    return jsonResponse(
      {
        ok: false,
        data: null,
        error: { code: "MEMORY_EMBEDDING_UNAVAILABLE", message: "Embedding 服务不可用" },
        meta: { request_id: requestId, degraded: true, warnings },
      },
      503,
    );
  }

  // 未知错误
  console.error("Unhandled gateway error:", error);
  return jsonResponse(
    {
      ok: false,
      data: null,
      error: { code: "MEMORY_INTERNAL_ERROR", message: "存储服务内部错误" },
      meta: { request_id: requestId },
    },
    500,
  );
}
