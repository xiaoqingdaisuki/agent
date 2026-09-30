import { describe, expect, it } from "vitest";

import { TextSplitter } from "../../src/rag/splitter.js";

const metadata = { source: "test", filename: "test.txt" };

describe("RAG text splitting", () => {
  it("splits an allowed large upload without exhausting the call stack", () => {
    const chunks = new TextSplitter().split({ content: "A".repeat(8_000_000), metadata });

    expect(chunks).toHaveLength(10_000);
    expect(chunks[0].metadata.totalChunks).toBe(chunks.length);
    expect(chunks.every((chunk) => chunk.text.length <= 1000)).toBe(true);
  });

  it("retains the middle of documents when overlap exceeds an early paragraph break", () => {
    const content = `${"A".repeat(400)}\n\n${"B".repeat(1000)}MIDDLE_MARKER${"C".repeat(1000)}`;
    const chunks = new TextSplitter({ chunkSize: 1000, chunkOverlap: 900 }).split({ content, metadata });

    expect(chunks.some((chunk) => chunk.text.includes("MIDDLE_MARKER"))).toBe(true);
    expect(chunks.every((chunk) => chunk.text.length <= 1000)).toBe(true);
  });

  it("only selects complete separators inside the size bound", () => {
    const chunks = new TextSplitter({ chunkSize: 10, chunkOverlap: 0 }).split({
      content: "123456789\n\nabcdef",
      metadata,
    });

    expect(chunks.map((chunk) => chunk.text)).toEqual(["123456789", "\nabcdef"]);
    expect(chunks.every((chunk) => chunk.text.length <= 10)).toBe(true);
  });

  it.each([[0, 0], [10, -1], [10, 10], [1.5, 0], [10, 0.5]])(
    "rejects invalid size %s and overlap %s",
    (chunkSize, chunkOverlap) => {
      expect(() => new TextSplitter({ chunkSize, chunkOverlap })).toThrow(RangeError);
    },
  );
});
