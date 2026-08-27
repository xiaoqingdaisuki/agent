import { describe, expect, it } from "vitest";

import { config } from "../../src/config/index.js";
import { KnowledgeService } from "../../src/services/index.js";
import { mockCloudflareClient } from "../vitest.setup.js";

describe("RAG document indexing", () => {
  it("uploads through the persistent Gateway and keeps its document id", async () => {
    const result = await KnowledgeService.uploadDocument(Buffer.from("hello"), "note.txt");

    expect(mockCloudflareClient.uploadDocument).toHaveBeenCalledTimes(1);
    expect(result.chunks).toBe(1);
    expect(result.id).toBe("doc_test");
  });

  it("supports the complete document lifecycle when memory is disabled", async () => {
    const originalMemoryEnabled = config.MEMORY_ENABLED;
    (config as { MEMORY_ENABLED: boolean }).MEMORY_ENABLED = false;
    try {
      const document = await KnowledgeService.uploadDocument(
        Buffer.from("本地知识库包含缓存和流式响应。"),
        "local-note.txt",
        "tech",
      );

      expect((await KnowledgeService.listDocuments()).map((item) => item.id)).toContain(document.id);
      expect(await KnowledgeService.getDocument(document.id)).toEqual(document);
      expect(await KnowledgeService.search("缓存", 3)).toEqual([
        expect.objectContaining({ document_id: document.id, score: 1 }),
      ]);
      expect(await KnowledgeService.reindexDocument(document.id)).toEqual(
        expect.objectContaining({ id: document.id, status: "indexed", chunks: 1 }),
      );
      expect(await KnowledgeService.deleteDocument(document.id)).toBe(true);
      expect(await KnowledgeService.getDocument(document.id)).toBeUndefined();
    } finally {
      (config as { MEMORY_ENABLED: boolean }).MEMORY_ENABLED = originalMemoryEnabled;
    }
  });

  it("isolates local documents by trusted user scope", async () => {
    const originalMemoryEnabled = config.MEMORY_ENABLED;
    (config as { MEMORY_ENABLED: boolean }).MEMORY_ENABLED = false;
    try {
      const document = await KnowledgeService.uploadDocument(
        Buffer.from("仅属于用户 A 的隔离文档"),
        "owner-a.txt",
        "tech",
        "owner-a",
      );

      expect(await KnowledgeService.getDocument(document.id, "owner-b")).toBeUndefined();
      expect(await KnowledgeService.listDocuments("owner-b")).not.toContainEqual(
        expect.objectContaining({ id: document.id }),
      );
      expect(await KnowledgeService.search("隔离文档", 3, "owner-b")).toEqual([]);
      expect(await KnowledgeService.deleteDocument(document.id, "owner-b")).toBe(false);
      expect(await KnowledgeService.deleteDocument(document.id, "owner-a")).toBe(true);
    } finally {
      (config as { MEMORY_ENABLED: boolean }).MEMORY_ENABLED = originalMemoryEnabled;
    }
  });
});
