/**
 * file.read — 安全读取工作区文件
 *
 * 安全特性:
 * - 路径规范化：防止路径穿越 (../)
 * - 根目录约束：只能访问工作区内的文件
 * - 符号链接防逃逸
 * - 文件类型/大小白名单
 * - 编码检测
 * - 分段读取：大文件支持 offset/limit
 * - 敏感内容脱敏
 */

import { DynamicStructuredTool } from "langchain/tools";
import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";

import type { ToolDescriptor } from "./contracts.js";

// ============ 安全限制 ============

const ALLOWED_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".cfg",
  ".py",
  ".js",
  ".ts",
  ".java",
  ".go",
  ".rs",
  ".c",
  ".cpp",
  ".h",
  ".html",
  ".css",
  ".xml",
  ".csv",
  ".tsv",
  ".sql",
  ".sh",
  ".bash",
  ".zsh",
  ".bat",
  ".ps1",
  ".log",
  ".env.example",
  ".gitignore",
  ".dockerfile",
  ".license",
  ".readme",
]);

/** 禁止读取的敏感文件名 */
const BLOCKED_FILENAMES = new Set([
  ".env",
  ".env.local",
  ".env.production",
  ".env.dev",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
]);

const MAX_FILE_SIZE = 1 * 1024 * 1024; // 1MB
const MAX_READ_CHARS = 50_000;

const SENSITIVE_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  {
    pattern: /(api[_-]?key|apikey)\s*[:=]\s*['"]?([A-Za-z0-9_\-]{16,})['"]?/gi,
    replacement: "***REDACTED***",
  },
  {
    pattern: /(password|passwd|pwd)\s*[:=]\s*['"]?([^'\"\s]{4,})['"]?/gi,
    replacement: "***REDACTED***",
  },
  {
    pattern: /(token|secret)\s*[:=]\s*['"]?([A-Za-z0-9_\-\.]{16,})['"]?/gi,
    replacement: "***REDACTED***",
  },
  {
    pattern:
      /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:RSA\s+)?PRIVATE\s+KEY-----/gi,
    replacement: "***REDACTED***",
  },
];

// ============ 编码检测 ============

/**
 * 依次尝试 UTF-8 / GBK / Latin-1，返回首个可成功解码的编码名
 */
function detectEncoding(buffer: Buffer): string {
  // UTF-8
  try {
    buffer.toString("utf-8");
    return "utf-8";
  } catch {
    // fall through
  }
  // GBK: Node.js 不原生支持 GBK，通过 try/catch 探测
  try {
    buffer.toString("gbk" as BufferEncoding);
    return "gbk";
  } catch {
    // fall through
  }
  // Latin-1: 1:1 字节映射，总是成功
  try {
    buffer.toString("latin1");
    return "latin-1";
  } catch {
    // fall through
  }
  return "utf-8";
}

// ============ 安全路径解析 ============

// 安全解析文件路径，防止路径穿越和工作区逃逸
export function resolveSafePath(
  filepath: string,
  rootDir: string,
): { path: string | null; error?: string } {
  const cleanPath = filepath.trim();

  if (!cleanPath) {
    return { path: null, error: "文件路径不能为空" };
  }

  if (path.isAbsolute(cleanPath)) {
    return { path: null, error: "文件路径必须相对于工作区" };
  }

  // 拒绝路径穿越
  const parts = cleanPath.split(/[/\\]/);
  if (parts.includes("..")) {
    return { path: null, error: "路径包含非法穿越序列 (..)" };
  }

  // 构建绝对路径并验证在根目录内
  const root = path.resolve(rootDir || ".");
  const fullPath = path.resolve(root, cleanPath);
  const relative = path.relative(root, fullPath);
  if (
    relative.startsWith(`..${path.sep}`) ||
    relative === ".." ||
    path.isAbsolute(relative)
  ) {
    return { path: null, error: "文件路径超出工作区范围" };
  }

  return { path: fullPath };
}

/**
 * 检查符号链接是否指向工作区外
 */
async function checkSymlink(
  safePath: string,
  workspaceRoot: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const realRoot = await fs.realpath(workspaceRoot);
    const realPath = await fs.realpath(safePath);
    const relative = path.relative(realRoot, realPath);
    if (
      relative.startsWith(`..${path.sep}`) ||
      relative === ".." ||
      path.isAbsolute(relative)
    ) {
      return { ok: false, error: "符号链接指向工作区外" };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "无法解析符号链接（可能指向循环链接）" };
  }
}

// 对文本内容进行敏感信息脱敏处理
export function maskSensitive(content: string): string {
  let masked = content;
  for (const { pattern, replacement } of SENSITIVE_PATTERNS) {
    masked = masked.replace(pattern, replacement);
  }
  return masked;
}

// ============ Tool Descriptor ==========

export const fileReadInputSchema = z.object({
  filepath: z.string().describe("要读取的文件路径，如 'README.md' 或 'src/main.py'"),
  offset: z.number().int().min(0).default(0).describe("起始行号（从0开始）"),
  limit: z.number().int().min(1).max(500).default(100).describe("最多读取行数"),
});

export const fileReadDescriptor: ToolDescriptor = {
  name: "file.read",
  version: "1.0.0",
  title: "文件读取",
  description:
    "安全读取工作区内的指定文件内容。支持文本文件（代码、配置、文档等）。自动进行路径安全检查，防止访问工作区外的文件。大文件支持分段读取。",
  category: "READ",
  risk_level: "R1",
  side_effect: "read",
  timeout_ms: 10000,
  required_permissions: ["file.read"],
  data_classification: ["internal"],
  owner: "tools",
  tags: ["file", "read", "workspace"],
  input_schema: fileReadInputSchema,
};

// ============ LangChain Tool ==========

export const fileReadTool: DynamicStructuredTool = new DynamicStructuredTool({
  name: "file_read",
  description:
    "安全读取工作区内的指定文件内容。自动进行路径安全检查。大文件支持通过 offset/limit 分段读取。",
  schema: fileReadInputSchema,
  func: async ({ filepath, offset, limit }) => {
    // 1. 路径安全检查
    const workspaceRoot = path.resolve(
      process.env.AGENT_WORKSPACE_ROOT || process.cwd(),
    );
    const { path: safePath, error } = resolveSafePath(filepath, workspaceRoot);
    if (!safePath) {
      return `❌ 路径安全拒绝：${error}`;
    }

    const filename = path.basename(safePath);

    // 2. 检查禁止的文件名
    if (BLOCKED_FILENAMES.has(filename)) {
      return `❌ 安全拒绝：禁止读取敏感文件 ${filename}`;
    }

    // 3. 检查文件是否存在
    try {
      const stat = await fs.stat(safePath);
      if (!stat.isFile()) {
        return `❌ 路径不是文件：${filepath}`;
      }

      // 4. 检查文件大小
      if (stat.size > MAX_FILE_SIZE) {
        return `❌ 文件过大（${(stat.size / 1024).toFixed(0)}KB），最大允许 ${MAX_FILE_SIZE / 1024}KB`;
      }

      // 5. 检查扩展名
      const ext = path.extname(safePath).toLowerCase();
      if (!ALLOWED_EXTENSIONS.has(ext)) {
        return `❌ 不支持的文件类型：${ext}`;
      }

      // 6. 检查符号链接
      const symlinkCheck = await checkSymlink(safePath, workspaceRoot);
      if (!symlinkCheck.ok) {
        return `❌ 符号链接安全拒绝：${symlinkCheck.error}`;
      }

      // 7. 读取文件内容（先读字节，再检测编码解码）
      const buffer = await fs.readFile(safePath);
      const encoding = detectEncoding(buffer);
      const content = buffer.toString(encoding as BufferEncoding);

      // 8. 敏感内容脱敏
      const masked = maskSensitive(content);

      // 9. 分段读取
      const lines = masked.split("\n");
      const totalLines = lines.length;

      if (offset > 0 && offset >= totalLines) {
        return `❌ 偏移量超出文件行数（共 ${totalLines} 行）`;
      }

      const end = Math.min(offset + limit, totalLines);
      const selected = lines.slice(offset, end);

      // 10. 构建返回
      let header = `📄 文件：${filepath}\n`;
      header += `编码：${encoding} | 大小：${(buffer.length / 1024).toFixed(1)}KB | 行数：${totalLines}\n`;

      if (offset > 0 || end < totalLines) {
        header += `显示第 ${offset + 1}-${end} 行（共 ${totalLines} 行）\n`;
      }

      header += "─".repeat(40) + "\n\n";

      let body = selected.join("\n");

      if (end < totalLines) {
        body += `\n\n...（共 ${totalLines} 行，已显示 ${end} 行，剩余 ${totalLines - end} 行未显示）`;
      }

      return header + body;
    } catch (error) {
      return `❌ 读取文件失败：${error instanceof Error ? error.message : "未知错误"}`;
    }
  },
});
