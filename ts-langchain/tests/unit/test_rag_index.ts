import { describe, expect, it } from "vitest";

import { KnowledgeService } from "../../src/services/index.js";
import { mockCloudflareClient } from "../vitest.setup.js";

describe("RAG document indexing", () => {
  it("uploads through the persistent Gateway and keeps its document id", async () => {
    const result = await KnowledgeService.uploadDocument(Buffer.from("hello"), "note.txt");

    expect(mockCloudflareClient.uploadDocument).toHaveBeenCalledTimes(1);
    expect(result.chunks).toBe(1);
    expect(result.id).toBe("doc_test");
  });
});
