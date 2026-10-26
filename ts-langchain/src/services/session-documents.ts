/** 解析临时附件并构建带文件位置的会话文档上下文 */

import path from "node:path";
import mammoth from "mammoth";
import { getDocumentProxy } from "unpdf";

export interface SessionDocumentPart {
  partIndex: number;
  page?: number;
  section?: string;
  content: string;
}

export interface SessionDocument {
  localId: string;
  filename: string;
  mimeType: string;
  size: number;
  parserVersion: string;
  parts: SessionDocumentPart[];
}

const SESSION_DOCUMENT_MAX_BYTES = 2_500_000;
const SESSION_DOCUMENT_MAX_TEXT_BYTES = 1_000_000;
const SESSION_DOCUMENT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".json",
  ".csv",
  ".pdf",
  ".docx",
]);

// 将解析后的正文切分为有界的临时上下文段落
function buildSessionDocumentParts(
  content: string,
  page?: number,
): SessionDocumentPart[] {
  const normalized = content.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return [];
  return normalized
    .split(/\n{2,}/)
    // 移除文档段落两端的空白字符
    .map((part) => part.trim())
    .filter(Boolean)
    // 将超长段落继续拆分为有长度上限的片段
    .flatMap((part) => part.match(/[\s\S]{1,20000}/gu) ?? [])
    // 为文档片段附加段落序号和页码
    .map((part, index) => ({
      partIndex: index,
      page,
      content: part,
    }));
}

// 解析 PDF 页面文本，保留页码供模型定位来源
async function parsePdfDocument(buffer: Buffer): Promise<SessionDocumentPart[]> {
  const parser = await getDocumentProxy(new Uint8Array(buffer));
  try {
    if (parser.numPages > 200) throw new Error("PDF_PAGE_LIMIT_EXCEEDED");
    let partIndex = 0;
    let textBytes = 0;
    const parts: SessionDocumentPart[] = [];
    for (let pageNumber = 1; pageNumber <= parser.numPages; pageNumber += 1) {
      const page = await parser.getPage(pageNumber);
      const content = await page.getTextContent();
      // 提取 PDF 文本项并保留行结束信息
      const text = content.items.map((item) => "str" in item ? `${item.str}${item.hasEOL ? "\n" : ""}` : "").join("");
      textBytes += Buffer.byteLength(text, "utf8");
      if (textBytes > SESSION_DOCUMENT_MAX_TEXT_BYTES) throw new Error("SESSION_DOCUMENT_TEXT_TOO_LARGE");
      // 为各页解析结果分配连续片段序号
      const pageParts = buildSessionDocumentParts(text, pageNumber).map((part) => ({
        ...part,
        partIndex: partIndex++,
      }));
      parts.push(...pageParts);
      page.cleanup();
    }
    return parts;
  } finally {
    await parser.loadingTask.destroy();
  }
}

// 解析 DOCX 正文，去除格式后保留段落内容供模型使用
async function parseDocxDocument(buffer: Buffer): Promise<SessionDocumentPart[]> {
  const result = await mammoth.extractRawText({ buffer, arrayBuffer: new Uint8Array(buffer).buffer });
  return buildSessionDocumentParts(result.value);
}

// 解析关闭记忆模式下的临时文档，只返回当前请求所需的文本上下文
export async function parseSessionDocument(
  buffer: Buffer,
  filename: string,
  mimeType = "application/octet-stream",
): Promise<SessionDocument> {
  if (buffer.byteLength > SESSION_DOCUMENT_MAX_BYTES) {
    throw new Error("SESSION_DOCUMENT_TOO_LARGE");
  }

  const extension = path.extname(filename).toLowerCase();
  if (!SESSION_DOCUMENT_EXTENSIONS.has(extension)) {
    throw new Error("SESSION_DOCUMENT_UNSUPPORTED");
  }

  let parts: SessionDocumentPart[];
  if (extension === ".pdf") {
    try {
      parts = await parsePdfDocument(buffer);
    } catch (error) {
      throw new Error("SESSION_DOCUMENT_PARSE_FAILED", { cause: error });
    }
  } else if (extension === ".docx") {
    try {
      parts = await parseDocxDocument(buffer);
    } catch (error) {
      throw new Error("SESSION_DOCUMENT_PARSE_FAILED", { cause: error });
    }
  } else {
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(buffer).replace(/^\uFEFF/, "");
    } catch {
      throw new Error("SESSION_DOCUMENT_INVALID_ENCODING");
    }

    const encodedLength = Buffer.byteLength(content, "utf8");
    if (encodedLength > SESSION_DOCUMENT_MAX_TEXT_BYTES) {
      throw new Error("SESSION_DOCUMENT_TEXT_TOO_LARGE");
    }
    parts = buildSessionDocumentParts(content, 1);
  }

  // 提取解析片段正文以重建文档内容
  const extractedTextBytes = Buffer.byteLength(parts.map((part) => part.content).join("\n\n"), "utf8");
  if (extractedTextBytes > SESSION_DOCUMENT_MAX_TEXT_BYTES) {
    throw new Error("SESSION_DOCUMENT_TEXT_TOO_LARGE");
  }
  if (parts.length === 0) throw new Error("SESSION_DOCUMENT_EMPTY");

  return {
    localId: crypto.randomUUID(),
    filename: filename.slice(0, 255),
    mimeType,
    size: buffer.byteLength,
    parserVersion: "session-document-v2",
    parts,
  };
}

// 将临时文档段落包装为不可信参考文本，防止文档内容覆盖系统指令
export function formatSessionDocumentContext(documents: SessionDocument[]): string {
  return documents
    // 按文档整理带名称及位置的临时片段上下文
    .flatMap((document) =>
      document.parts.map(
        // 为每个临时片段附加文件名称及页码或段落序号
        (part) =>
          `[临时文档：${document.filename}，第 ${part.page ?? part.partIndex + 1} 段]\n${part.content}`,
      ),
    )
    .join("\n\n");
}

export const SESSION_DOCUMENT_LIMITS = {
  maxBytes: SESSION_DOCUMENT_MAX_BYTES,
  maxTextBytes: SESSION_DOCUMENT_MAX_TEXT_BYTES,
  extensions: [...SESSION_DOCUMENT_EXTENSIONS],
} as const;
