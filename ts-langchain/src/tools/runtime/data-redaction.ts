/**
 * 数据脱敏工具
 *
 * 两层保护：
 *   1. 结构化数据：按 key 名过滤敏感字段（api_key, password, token 等）
 *   2. 内容级脱敏：对纯文本中的敏感值做正则替换（Bearer tokens、密钥格式、
 *      内部路径、邮箱等），防止工具返回的日志/报错/原始文本泄露敏感信息
 *
 * 设计原则：
 * - 替换为 [REDACTED]，保留数据结构和文本可读性
 * - 不修改原始数据，返回新对象/新字符串
 * - 脱敏规则集中管理，新增规则只需扩展 _CONTENT_PATTERNS
 */

// ============ 结构化数据脱敏 ============

/** 需要按 key 脱敏的字段名集合 */
const SENSITIVE_KEYS = new Set([
  "api_key",
  "apikey",
  "secret",
  "password",
  "token",
  "access_token",
  "refresh_token",
  "private_key",
  "authorization",
  "credentials",
  "passwd",
  "pwd",
  "credential",
  "key",
  "cert",
  "cookie",
  "session_id",
  "csrf_token",
]);

// 对结构化数据递归脱敏 — 按 key 名过滤 + 对字符串值做内容级脱敏
export function redactStructuredData<T>(data: T): T {
  if (data === null || data === undefined) return data;

  if (Array.isArray(data)) {
    return data.map(redactStructuredData) as T;
  }

  if (typeof data === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.has(key.toLowerCase())) {
        result[key] = "[REDACTED]";
      } else if (typeof value === "string") {
        result[key] = redactTextContent(value);
      } else {
        result[key] = redactStructuredData(value);
      }
    }
    return result as T;
  }

  return data;
}

// ============ 内容级脱敏 ============

/** 需要从文本内容中脱敏的正则规则 */
interface RedactionRule {
  name: string;
  pattern: RegExp;
  replacement: string | ((match: string) => string);
}

// 仅遮蔽具有 JSON 头部和载荷的 JWT，保留普通域名和版本号
function redactJwtCandidate(candidate: string): string {
  try {
    const [encodedHeader, encodedPayload] = candidate.split(".");
    const header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8"));
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
    return header && typeof header === "object" && typeof header.alg === "string" &&
      payload && typeof payload === "object" && !Array.isArray(payload)
      ? "[REDACTED]"
      : candidate;
  } catch {
    return candidate;
  }
}

const CONTENT_REDACTION_RULES: RedactionRule[] = [
  // Bearer 与 Authorization 认证令牌
  {
    name: "bearer_token",
    pattern: /(Bearer\s+)[A-Za-z0-9\-._~+/]+=*/gi,
    replacement: "$1[REDACTED]",
  },
  {
    name: "auth_header",
    pattern: /(Authorization:[ \t]*)[^\r\n,;]+/gi,
    replacement: "$1[REDACTED]",
  },
  // API keys — 长十六进制字符串 (64+ chars)
  {
    name: "hex_api_key",
    pattern: /\b[a-f0-9]{64,}\b/gi,
    replacement: "[REDACTED]",
  },
  // JWT 认证令牌
  {
    name: "jwt",
    pattern: /[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]*/g,
    replacement: redactJwtCandidate,
  },
  // 私钥内容
  {
    name: "private_key",
    pattern: /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:RSA\s+)?PRIVATE\s+Key-----/gi,
    replacement: "[REDACTED]",
  },
  // AWS 格式访问密钥
  {
    name: "aws_key",
    pattern: /\b(AKIA|ASIA)[A-Z0-9]{16}\b/g,
    replacement: "[REDACTED]",
  },
  // 可能泄露服务器结构的内部文件路径
  {
    name: "server_path",
    pattern: /(?:[A-Za-z]:\\|\/)(?:home|var|etc|usr|root|opt|app|deploy|srv|mnt)[\/\\][^\s"'<>]*/gi,
    replacement: "[INTERNAL_PATH]",
  },
  // 电子邮箱地址
  {
    name: "email",
    pattern: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g,
    replacement: "[REDACTED_EMAIL]",
  },
  // 内部网段 IP 地址
  {
    name: "internal_ip",
    pattern: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b/g,
    replacement: "[REDACTED_IP]",
  },
  // 文本中的常见密码格式
  {
    name: "password_inline",
    pattern: /(password|passwd|pwd|pass)\s*[=:]\s*["']?[^\s"',;)}\]]+["']?/gi,
    replacement: "$1=[REDACTED]",
  },
];

// 对纯文本内容做内容级脱敏，替换敏感信息为占位符
export function redactTextContent(text: string): string {
  let result = text;
  for (const rule of CONTENT_REDACTION_RULES) {
    result = typeof rule.replacement === "string"
      ? result.replace(rule.pattern, rule.replacement)
      : result.replace(rule.pattern, rule.replacement);
  }
  return result;
}

// 对任意类型的数据做脱敏处理：；- 结构化对象：按 key 过滤 + 递归脱敏字符串值；- 纯文本：内容级正则脱敏；- 其他类型：原样返回
export function redactData<T>(data: T): T {
  if (typeof data === "string") {
    return redactTextContent(data) as T;
  }
  return redactStructuredData(data);
}
