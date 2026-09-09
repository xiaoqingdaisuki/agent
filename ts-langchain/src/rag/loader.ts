/**
 * RAG 文档加载器
 * 支持 TXT、Markdown、PDF、DOCX 文件
 */

import * as fs from "fs/promises";
import * as path from "path";
import { parseSessionDocument } from "../services/session-documents.js";

export interface Document {
  id: string;
  content: string;
  metadata: {
    source: string;
    filename: string;
    fileType: string;
    size: number;
    uploadedAt: string;
  };
}

export class DocumentLoader {
  /**
   * 根据文件类型选择加载器
   */
  // 根据文件类型选择合适的加载器读取文档
  static async load(filePath: string, filename: string): Promise<Document> {
    const ext = path.extname(filename).toLowerCase();
    const content = await fs.readFile(filePath, "utf-8");
    const stats = await fs.stat(filePath);

    const doc: Document = {
      id: crypto.randomUUID(),
      content,
      metadata: {
        source: filePath,
        filename,
        fileType: ext,
        size: stats.size,
        uploadedAt: new Date().toISOString(),
      },
    };

    return doc;
  }

  /**
   * 从 Buffer 加载（用于上传场景）
   */
  // 从 Buffer 加载文档（用于上传场景）
  static async loadFromBuffer(
    buffer: Buffer,
    filename: string,
    contentAlreadyParsed = false,
  ): Promise<Document> {
    const ext = path.extname(filename).toLowerCase();
    const content = contentAlreadyParsed
      ? buffer.toString("utf-8")
      : (await parseSessionDocument(buffer, filename, "application/octet-stream"))
          .parts.map((part) => part.content)
          .join("\n\n");

    return {
      id: crypto.randomUUID(),
      content,
      metadata: {
        source: `upload://${filename}`,
        filename,
        fileType: ext,
        size: buffer.length,
        uploadedAt: new Date().toISOString(),
      },
    };
  }
}
