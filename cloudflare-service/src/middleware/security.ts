/**
 * 安全中间件
 *
 * - 内容脱敏（过滤 API Key、密码等敏感模式）
 * - 验证记忆内容长度
 * - 验证分页参数
 */

// 敏感信息正则模式
const SENSITIVE_PATTERNS = [
  /\b(?:sk|pk|token|key|secret|password|passwd|pwd|api[_-]?key)\s*[:=]\s*\S+/gi,
  /\b(?:bearer\s+)[a-zA-Z0-9\-._~+/]+=*/gi,
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
];

// 脱敏文本内容
export function redactSensitive(text: string): string {
  let result = text;
  for (const pattern of SENSITIVE_PATTERNS) {
    result = result.replace(pattern, "[REDACTED]");
  }
  return result;
}

// 验证记忆内容长度
export function validateMemoryContent(content: string): { valid: boolean; error?: string } {
  if (!content || content.trim().length === 0) {
    return { valid: false, error: "记忆内容不能为空" };
  }
  if (content.length > 500) {
    return { valid: false, error: "记忆内容不能超过 500 字符" };
  }
  return { valid: true };
}

// 验证分页参数
export function validatePagination(limit?: number, offset?: number): { limit: number; offset: number } {
  const l = typeof limit === "number" ? Math.min(Math.max(limit, 1), 100) : 50;
  const o = typeof offset === "number" ? Math.max(offset, 0) : 0;
  return { limit: l, offset: o };
}

// 请求日志中间件
export async function requestLogMiddleware(c: any, next: () => Promise<void>) {
  const start = Date.now();
  try {
    await next();
  } finally {
    const duration = Date.now() - start;
    const method = c.req.method;
    const path = c.req.path;
    let status = 0;
    try {
      status = c.res?.status || 0;
    } catch {
      // c.res 在某些环境下可能不可访问
    }
    if (status >= 400 || duration > 1000) {
      console.log(`[GW] ${method} ${path} → ${status} (${duration}ms)`);
    }
  }
}
