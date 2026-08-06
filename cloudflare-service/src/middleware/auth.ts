/**
 * Bearer Secret 鉴权中间件
 *
 * 验证 Authorization: Bearer <SERVICE_SECRET>
 * 将认证结果附加到 c.set() 供后续路由使用
 */

// 从请求头提取并验证 Bearer token
export async function authMiddleware(c: any, next: any) {
  const secret = c.env.SERVICE_SECRET?.trim() || "";
  if (!secret) {
    return c.json(
      {
        ok: false,
        data: null,
        error: { code: "MEMORY_SERVICE_MISCONFIGURED", message: "服务认证密钥未配置" },
        meta: { request_id: c.get("requestId") },
      },
      503,
    );
  }

  const authHeader = c.req.header("Authorization");

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return c.json(
      {
        ok: false,
        data: null,
        error: { code: "MEMORY_UNAUTHENTICATED", message: "缺少或无效的认证凭证" },
        meta: { request_id: c.get("requestId") },
      },
      401,
    );
  }

  const token = authHeader.slice(7);

  if (token !== secret) {
    return c.json(
      {
        ok: false,
        data: null,
        error: { code: "MEMORY_UNAUTHENTICATED", message: "认证令牌无效" },
        meta: { request_id: c.get("requestId") },
      },
      401,
    );
  }

  // 认证通过
  c.set("authenticated", true);
  c.set("requestId", c.req.header("X-Request-Id") || `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`);

  await next();
}

// 公开路径（无需认证）
export const PUBLIC_PATHS = ["/internal/v1/health"];

// 判断是否为公开路径
export function isPublicPath(path: string): boolean {
  return PUBLIC_PATHS.some((p) => path === p || path.startsWith(p));
}
