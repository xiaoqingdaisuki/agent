import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { config } from "../../config/index.js";
import {
  BusinessError,
  BusinessErrorCode,
} from "../../services/index.js";

const PUBLIC_PATHS = new Set(["/health", "/api/v1/health"]);
const USER_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

declare module "fastify" {
  interface FastifyRequest {
    agentUserId?: string;
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
  });
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
