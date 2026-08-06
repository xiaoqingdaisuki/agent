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
  return error?.message?.includes("AI") || error?.message?.includes("workers-ai");
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

  // D1 错误
  if (error?.code && D1_ERROR_MAP[error.code]) {
    const code = D1_ERROR_MAP[error.code];
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
