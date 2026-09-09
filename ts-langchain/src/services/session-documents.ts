import path from "node:path";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";

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

// 将解析后的正文切分为有界的临时上下文段落。
function buildSessionDocumentParts(
  content: string,
  page?: number,
): SessionDocumentPart[] {
  const normalized = content.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return [];
  return normalized
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part, index) => ({
      partIndex: index,
      page,
      content: part.slice(0, 20_000),
    }));
}

// 解析 PDF 页面文本，保留页码供模型定位来源。
async function parsePdfDocument(buffer: Buffer): Promise<SessionDocumentPart[]> {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    let partIndex = 0;
    return result.pages.flatMap((page) => {
      const pageParts = buildSessionDocumentParts(page.text, page.num).map((part) => ({
        ...part,
        partIndex: partIndex++,
      }));
      return pageParts;
    });
  } finally {
    await parser.destroy();
  }
}

// 解析 DOCX 正文，去除格式后保留段落内容供模型使用。
async function parseDocxDocument(buffer: Buffer): Promise<SessionDocumentPart[]> {
  const result = await mammoth.extractRawText({ buffer });
  return buildSessionDocumentParts(result.value);
}

// 解析关闭记忆模式下的临时文档，只返回当前请求所需的文本上下文。
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

// 将临时文档段落包装为不可信参考文本，防止文档内容覆盖系统指令。
export function formatSessionDocumentContext(documents: SessionDocument[]): string {
  return documents
    .flatMap((document) =>
      document.parts.map(
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
