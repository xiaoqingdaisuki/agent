import { describe, expect, it, vi } from "vitest";

import { RAGAgent } from "../../src/rag/rag-agent.js";
import { TextSplitter } from "../../src/rag/splitter.js";

describe("RAG document indexing", () => {
  it("embeds and upserts chunks with a stable document id", async () => {
    const addDocuments = vi.fn().mockResolvedValue(undefined);
    const embedBatch = vi.fn().mockResolvedValue([[0.1, 0.2]]);
    const agent = Object.create(RAGAgent.prototype) as RAGAgent & Record<string, unknown>;
    agent.splitter = new TextSplitter();
    agent.embedder = { embedBatch };
    agent.vectorStore = { addDocuments };

    const result = await agent.indexDocument("hello", "note.txt", "doc-1");

    expect(result.chunks).toBe(1);
    expect(embedBatch).toHaveBeenCalledWith(["hello"]);
    expect(addDocuments.mock.calls[0][0][0].metadata.document_id).toBe("doc-1");
  });
});
