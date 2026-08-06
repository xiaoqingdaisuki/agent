/**
 * Document Routes — 文档管理
 *
 * POST   /internal/v1/documents                    — 上传文档
 * GET    /internal/v1/documents                    — 列出用户文档
 * GET    /internal/v1/documents/:id                 — 文档详情（含块）
 * DELETE /internal/v1/documents/:id                 — 删除文档
 * POST   /internal/v1/documents/:id/reindex         — 重新索引
 * POST   /internal/v1/documents:search              — 语义搜索
 */

import {
  createDocument,
  getDocument,
  listDocuments,
  deleteDocument,
  getChunksByDocument,
  deleteChunksByDocument,
  searchDocuments,
  splitText,
  hashContent,
  createChunksBatch,
} from "../repositories/document.js";
import { getEmbeddingBatch } from "../services/embedding.js";
import {
  DocumentUploadRequestSchema,
  DocumentSearchRequestSchema,
  DocumentListQuerySchema,
} from "../schemas/document-models.js";

// 创建或注册 registerDocumentRoutes 所需的数据
export function registerDocumentRoutes(app: any) {
  // 上传文档
  app.post("/internal/v1/documents", async (c: any) => {
    const body = await c.req.json();
    const parsed = DocumentUploadRequestSchema.parse(body);

    const userId = (body as any).user_id as string;
    if (!userId) {
      return c.json(
        { ok: false, data: null, error: { code: "DOCUMENT_BAD_REQUEST", message: "user_id is required" }, meta: { request_id: c.get("requestId"), degraded: false, warnings: [] } },
        400,
      );
    }

    try {
      // 解码 base64 内容（Cloudflare Workers 环境）
      const binaryString = atob(parsed.content);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      const content = new TextDecoder().decode(bytes);
      const docId = crypto.randomUUID();
      const sizeBytes = bytes.length;

      const { document, degraded } = await createDocument(c.env.DB, c.env.MEMORY_INDEX, c.env.AI, {
        id: docId,
        user_id: userId,
        name: parsed.filename,
        filename: parsed.filename,
        file_type: parsed.file_type ?? null,
        size: sizeBytes,
        category: parsed.category,
        content,
      });

      return c.json({
        ok: true,
        data: { document, degraded },
        error: null,
        meta: { request_id: c.get("requestId"), degraded, warnings: degraded ? ["Embedding degraded, using fallback"] : [] },
      });
    } catch (err: any) {
      console.error("Document upload failed:", err);
      return c.json(
        { ok: false, data: null, error: { code: "DOCUMENT_UPLOAD_FAILED", message: err.message || "Upload failed" }, meta: { request_id: c.get("requestId"), degraded: true, warnings: [] } },
        500,
      );
    }
  });

  // 列出文档
  app.get("/internal/v1/documents", async (c: any) => {
    const userId = c.req.query("user_id");
    if (!userId) {
      return c.json(
        { ok: false, data: null, error: { code: "DOCUMENT_BAD_REQUEST", message: "user_id query param is required" }, meta: { request_id: c.get("requestId"), degraded: false, warnings: [] } },
        400,
      );
    }

    try {
      const query = DocumentListQuerySchema.parse({
        limit: c.req.query("limit"),
        offset: c.req.query("offset"),
        category: c.req.query("category"),
      });

      const { documents, total } = await listDocuments(c.env.DB, userId as string, query.limit, query.offset, query.category ?? undefined);

      return c.json({
        ok: true,
        data: { documents, total },
        error: null,
        meta: { request_id: c.get("requestId"), degraded: false, warnings: [] },
      });
    } catch (err: any) {
      return c.json(
        { ok: false, data: null, error: { code: "DOCUMENT_LIST_FAILED", message: err.message || "List failed" }, meta: { request_id: c.get("requestId"), degraded: true, warnings: [] } },
        500,
      );
    }
  });

  // 获取文档详情
  app.get("/internal/v1/documents/:id", async (c: any) => {
    try {
      const documentId = c.req.param("id");
      const document = await getDocument(c.env.DB, documentId);

      if (!document) {
        return c.json(
          { ok: false, data: null, error: { code: "DOCUMENT_NOT_FOUND", message: "Document not found" }, meta: { request_id: c.get("requestId"), degraded: false, warnings: [] } },
          404,
        );
      }

      const chunks = await getChunksByDocument(c.env.DB, documentId);

      return c.json({
        ok: true,
        data: { document, chunks },
        error: null,
        meta: { request_id: c.get("requestId"), degraded: false, warnings: [] },
      });
    } catch (err: any) {
      return c.json(
        { ok: false, data: null, error: { code: "DOCUMENT_GET_FAILED", message: err.message || "Get failed" }, meta: { request_id: c.get("requestId"), degraded: true, warnings: [] } },
        500,
      );
    }
  });

  // 删除文档
  app.delete("/internal/v1/documents/:id", async (c: any) => {
    try {
      const documentId = c.req.param("id");

      const document = await getDocument(c.env.DB, documentId);
      if (!document) {
        return c.json(
          { ok: false, data: null, error: { code: "DOCUMENT_NOT_FOUND", message: "Document not found" }, meta: { request_id: c.get("requestId"), degraded: false, warnings: [] } },
          404,
        );
      }

      const deleted = await deleteDocument(c.env.DB, c.env.MEMORY_INDEX, documentId);

      return c.json({
        ok: true,
        data: { deleted },
        error: null,
        meta: { request_id: c.get("requestId"), degraded: false, warnings: [] },
      });
    } catch (err: any) {
      return c.json(
        { ok: false, data: null, error: { code: "DOCUMENT_DELETE_FAILED", message: err.message || "Delete failed" }, meta: { request_id: c.get("requestId"), degraded: true, warnings: [] } },
        500,
      );
    }
  });

  // 重新索引文档
  app.post("/internal/v1/documents/:id/reindex", async (c: any) => {
    try {
      const documentId = c.req.param("id");

      const document = await getDocument(c.env.DB, documentId);
      if (!document) {
        return c.json(
          { ok: false, data: null, error: { code: "DOCUMENT_NOT_FOUND", message: "Document not found" }, meta: { request_id: c.get("requestId"), degraded: false, warnings: [] } },
          404,
        );
      }

      // 优先使用存储的原始内容，无则从 chunks 拼接
      let fullText = document.content_text;
      if (!fullText) {
        const existingChunks = await getChunksByDocument(c.env.DB, documentId);
        if (existingChunks.length === 0) {
          return c.json(
            { ok: false, data: null, error: { code: "DOCUMENT_NO_CONTENT", message: "No content available for reindex" }, meta: { request_id: c.get("requestId"), degraded: false, warnings: [] } },
            400,
          );
        }
        fullText = existingChunks.map((ch) => ch.content).join("\n\n");
      }

      // 删除旧块
      await deleteChunksByDocument(c.env.DB, documentId);

      // 重新切分 + 嵌入
      const textChunks = splitText(fullText);

      const hashPromises = textChunks.map((chunk) => hashContent(chunk));
      const hashes = await Promise.all(hashPromises);

      let embeddings: number[][];
      let degraded = false;
      try {
        embeddings = await getEmbeddingBatch(c.env.AI, textChunks);
      } catch (err) {
        console.error("Reindex embedding failed:", err);
        embeddings = textChunks.map(() => new Array(1024).fill(0));
        degraded = true;
      }

      const now = new Date().toISOString();

      // 写入新块
      const newChunks = textChunks.map((text, i) => ({
        id: `${documentId}:chunk_${i}`,
        document_id: documentId,
        user_id: document.user_id,
        chunk_index: i,
        content: text,
        content_hash: hashes[i],
        embedding_model: "@cf/baai/bge-m3",
        embedding_version: 1,
        created_at: now,
      }));

      await createChunksBatch(c.env.DB, newChunks);

      // 写入 Vectorize
      const vectorizeIds = newChunks.map((ch) => `doc_${ch.id}`);
      const vectorizeMetadata = newChunks.map((ch) => ({
        entity_type: "document_chunk",
        document_id: ch.document_id,
        user_id: ch.user_id,
        chunk_index: ch.chunk_index,
        filename: document.filename,
      }));

      if (!degraded) {
        try {
          await c.env.MEMORY_INDEX.upsert(
            vectorizeIds.map((id, i) => ({
              id,
              values: embeddings[i],
              metadata: vectorizeMetadata[i],
            })),
          );

          for (let i = 0; i < vectorizeIds.length; i++) {
            await c.env.DB
              .prepare("UPDATE chunks SET vectorize_id = ? WHERE id = ?")
              .bind(vectorizeIds[i], newChunks[i].id)
              .run();
          }
        } catch (err) {
          console.error("Reindex Vectorize upsert failed:", err);
          degraded = true;
        }
      }

      // 更新文档状态
      await c.env.DB
        .prepare("UPDATE documents SET chunk_count = ?, status = ?, updated_at = ? WHERE id = ?")
        .bind(newChunks.length, degraded ? "failed" : "indexed", now, documentId)
        .run();

      return c.json({
        ok: true,
        data: { chunk_count: newChunks.length, degraded },
        error: null,
        meta: { request_id: c.get("requestId"), degraded, warnings: degraded ? ["Embedding degraded"] : [] },
      });
    } catch (err: any) {
      return c.json(
        { ok: false, data: null, error: { code: "DOCUMENT_REINDEX_FAILED", message: err.message || "Reindex failed" }, meta: { request_id: c.get("requestId"), degraded: true, warnings: [] } },
        500,
      );
    }
  });

  // 语义搜索
  app.post("/internal/v1/documents:search", async (c: any) => {
    const body = await c.req.json();
    const parsed = DocumentSearchRequestSchema.parse(body);

    const userId = (body as any).user_id as string;
    if (!userId) {
      return c.json(
        { ok: false, data: null, error: { code: "DOCUMENT_BAD_REQUEST", message: "user_id is required" }, meta: { request_id: c.get("requestId"), degraded: false, warnings: [] } },
        400,
      );
    }

    try {
      const { results, degraded } = await searchDocuments(
        c.env.DB,
        c.env.MEMORY_INDEX,
        c.env.AI,
        userId,
        parsed.query,
        { limit: parsed.limit, minScore: parsed.min_score },
      );

      return c.json({
        ok: true,
        data: { results, degraded },
        error: null,
        meta: { request_id: c.get("requestId"), degraded, warnings: degraded ? ["Search degraded to SQL"] : [] },
      });
    } catch (err: any) {
      return c.json(
        { ok: false, data: null, error: { code: "DOCUMENT_SEARCH_FAILED", message: err.message || "Search failed" }, meta: { request_id: c.get("requestId"), degraded: true, warnings: [] } },
        500,
      );
    }
  });
}
