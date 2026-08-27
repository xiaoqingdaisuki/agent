import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { config } from "../../config/index.js";
import {
  BusinessError,
  BusinessErrorCode,
} from "../../services/index.js";

const PUBLIC_PATHS = new Set([
  "/health",
  "/health/live",
  "/health/ready",
  "/api/v1/health",
  "/api/v1/health/live",
  "/api/v1/health/ready",
]);
const USER_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const TENANT_ID_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/;
const ALLOWED_ROLES = new Set(["viewer", "member", "admin"]);
const RATE_WINDOW_MS = 60_000;
const MAX_RATE_BUCKETS = 20_000;
type RateBucket = { count: number; resetAt: number };
const rateBuckets = new Map<string, RateBucket>();

export interface AgentToolIdentity {
  userId: string;
  tenantId: string;
  roles: string[];
}

declare module "fastify" {
  interface FastifyRequest {
    agentUserId?: string;
    agentTenantId?: string;
    agentRoles?: string[];
  }
}

// 使用恒定时间比较校验服务间共享密钥
function secretsMatch(provided: string, expected: string): boolean {
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  return (
    providedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(providedBuffer, expectedBuffer)
  );
}

// 从 Bearer 认证头中提取服务间密钥
function getBearerSecret(request: FastifyRequest): string {
  const authorization = request.headers.authorization;
  return authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";
}

// 对可信身份执行进程内固定窗口限流，并返回需要等待的秒数。
function consumeRateLimit(key: string, limit: number, now = Date.now()): number {
  let bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + RATE_WINDOW_MS };
    rateBuckets.set(key, bucket);
  }
  if (bucket.count >= limit) return Math.max(1, Math.ceil((bucket.resetAt - now) / 1_000));
  bucket.count += 1;
  if (rateBuckets.size > MAX_RATE_BUCKETS) {
    for (const [bucketKey, candidate] of rateBuckets) {
      if (candidate.resetAt <= now || rateBuckets.size > MAX_RATE_BUCKETS) rateBuckets.delete(bucketKey);
      if (rateBuckets.size <= MAX_RATE_BUCKETS) break;
    }
  }
  return 0;
}

// 注册外部 Agent API 的服务认证中间件
export function registerAgentAuthMiddleware(app: FastifyInstance): void {
  app.addHook("preHandler", async (request, reply) => {
    const pathname = request.url.split("?", 1)[0];
    if (PUBLIC_PATHS.has(pathname)) return;

    if (!config.AGENT_API_SECRET) {
      return reply.status(503).send({
        error: {
          code: BusinessErrorCode.SERVICE_UNAVAILABLE,
          message: "Agent API authentication is not configured",
        },
      });
    }
    if (!secretsMatch(getBearerSecret(request), config.AGENT_API_SECRET)) {
      return reply.status(401).send({
        error: {
          code: BusinessErrorCode.UNAUTHORIZED,
          message: "缺少或无效的认证凭证",
        },
      });
    }

    const rawUserId = request.headers["x-agent-user-id"];
    if (rawUserId !== undefined) {
      if (typeof rawUserId !== "string" || !USER_ID_PATTERN.test(rawUserId)) {
        return reply.status(400).send({
          error: {
            code: BusinessErrorCode.INVALID_REQUEST,
            message: "用户标识格式不正确",
          },
        });
      }
      request.agentUserId = rawUserId;
    }
    const rawTenantId = request.headers["x-agent-tenant-id"];
    if (rawTenantId !== undefined && (typeof rawTenantId !== "string" || !TENANT_ID_PATTERN.test(rawTenantId))) {
      return reply.status(400).send({
        error: { code: BusinessErrorCode.INVALID_REQUEST, message: "租户标识格式不正确" },
      });
    }
    request.agentTenantId = typeof rawTenantId === "string" ? rawTenantId : undefined;

    const rawRoles = request.headers["x-agent-roles"];
    const roles = typeof rawRoles === "string" && rawRoles.trim()
      ? [...new Set(rawRoles.split(",").map((role) => role.trim()).filter(Boolean))]
      : ["member"];
    if (typeof rawRoles !== "undefined" && (typeof rawRoles !== "string" || roles.some((role) => !ALLOWED_ROLES.has(role)))) {
      return reply.status(400).send({
        error: { code: BusinessErrorCode.INVALID_REQUEST, message: "角色标识格式不正确" },
      });
    }
    request.agentRoles = roles;

    if (rawUserId) {
      const tenantId = request.agentTenantId ?? `user:${rawUserId}`;
      const retryAfter = Math.max(
        consumeRateLimit(`user:${tenantId}:${rawUserId}`, config.USER_RATE_LIMIT_RPM),
        consumeRateLimit(`tenant:${tenantId}`, config.TENANT_RATE_LIMIT_RPM),
      );
      if (retryAfter > 0) {
        return reply.header("Retry-After", String(retryAfter)).status(429).send({
          error: { code: BusinessErrorCode.RATE_LIMITED, message: "请求过于频繁，请稍后重试" },
        });
      }
    }
  });
}

// 返回仅由已认证服务注入的完整工具身份。
export function getAgentToolIdentity(
  request: FastifyRequest,
  submittedUserId?: string,
): AgentToolIdentity {
  const userId = requireAgentUserId(request, submittedUserId);
  return {
    userId,
    tenantId: request.agentTenantId ?? `user:${userId}`,
    roles: request.agentRoles ?? ["member"],
  };
}

// 获取可信用户标识并拒绝请求参数冒充其他用户
export function requireAgentUserId(
  request: FastifyRequest,
  submittedUserId?: string,
): string {
  const trustedUserId = request.agentUserId;
  if (!trustedUserId) {
    throw new BusinessError(
      BusinessErrorCode.UNAUTHORIZED,
      "缺少可信用户标识",
      401,
    );
  }
  if (submittedUserId && submittedUserId !== trustedUserId) {
    throw new BusinessError(
      BusinessErrorCode.FORBIDDEN,
      "请求中的用户标识与认证身份不一致",
      403,
    );
  }
  return trustedUserId;
}
