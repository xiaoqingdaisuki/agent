/**
 * RAG 文档加载器
 * 支持 TXT, Markdown 文件
 */

import * as fs from "fs/promises";
import * as path from "path";

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
  static async loadFromBuffer(buffer: Buffer, filename: string): Promise<Document> {
    const ext = path.extname(filename).toLowerCase();
    const content = buffer.toString("utf-8");

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
