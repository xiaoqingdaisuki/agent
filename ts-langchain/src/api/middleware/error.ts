import type { FastifyInstance } from "fastify";
import { BusinessError } from "../../services/index.js";

const SENSITIVE_FIELD_PATTERN = /authorization|api[_-]?key|token|secret|password|cookie/i;
const MAX_LOGGED_TEXT_LENGTH = 10_000;

// 对日志中的非正文数据递归脱敏，并限制超长文本避免污染容器日志
function sanitizeLogValue(value: unknown, key = ""): unknown {
  if (SENSITIVE_FIELD_PATTERN.test(key)) return "[REDACTED]";
  if (typeof value === "string") {
    return value.length > MAX_LOGGED_TEXT_LENGTH
      ? `${value.slice(0, MAX_LOGGED_TEXT_LENGTH)}…[TRUNCATED]`
      : value;
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeLogValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([field, item]) => [
        field,
        sanitizeLogValue(item, field),
      ]),
    );
  }
  return value;
}

// 仅记录请求体元数据，避免把对话和文档原文写入日志。
function summarizeRequestBody(body: unknown): Record<string, unknown> | undefined {
  if (body === undefined || body === null) return undefined;
  return {
    present: true,
    fields: body && typeof body === "object" && !Array.isArray(body)
      ? Object.keys(body as Record<string, unknown>).sort()
      : [],
  };
}

// 输出包含请求上下文和原始异常的结构化错误日志，供 Docker 日志定位问题
export function logRequestError(
  request: {
    id?: string;
    method?: string;
    url?: string;
    params?: unknown;
    query?: unknown;
    body?: unknown;
    log: { error: (payload: unknown, message: string) => void };
  },
  error: unknown,
  context: Record<string, unknown> = {},
): void {
  request.log.error(
    {
      err: error,
      request_context: {
        request_id: request.id,
        method: request.method,
        url: request.url,
        params: sanitizeLogValue(request.params),
        query: sanitizeLogValue(request.query),
        body: summarizeRequestBody(request.body),
        ...(sanitizeLogValue(context) as Record<string, unknown>),
      },
    },
    "Agent request failed",
  );
}

// 注册全局错误处理中间件，将异常转换为统一 JSON 响应
export function registerErrorMiddleware(app: FastifyInstance) {
  app.setErrorHandler((error: any, request: any, reply: any) => {
    logRequestError(request, error);
    if (error instanceof BusinessError) {
      return reply.status(error.statusCode).send(error.toJSON());
    }
    const statusCode = Number(error.statusCode) || 500;
    const isValidationError = error.code === "FST_ERR_VALIDATION" || statusCode === 400;
    return reply.status(statusCode).send({
      error: {
        code: isValidationError ? "VALIDATION_ERROR" : "INTERNAL_ERROR",
        message: isValidationError ? "请求参数无效" : "Internal server error",
        ...(isValidationError && error.validation ? { details: { fields: error.validation } } : {}),
      },
    });
  });
}
