/**
 * 统一错误处理中间件
 *
 * 将内部错误映射为 Gateway 统一响应格式：
 * { ok: false, error: { code, message }, meta: { request_id, degraded, warnings } }
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

// 默认错误处理器
export function errorHandler(c: any, error: any) {
  const requestId = c.var.requestId || generateRequestId();
  const warnings: string[] = [];

  // HTTPException — Hono 原生异常
  if (error instanceof HTTPException) {
    return c.json(
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
    return c.json(
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
    return c.json(
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
    return c.json(
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
  return c.json(
    {
      ok: false,
      data: null,
      error: { code: "MEMORY_INTERNAL_ERROR", message: "存储服务内部错误" },
      meta: { request_id: requestId },
    },
    500,
  );
}

function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}
