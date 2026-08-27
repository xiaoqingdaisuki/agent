import { describe, expect, it, vi } from "vitest";

import app from "../src/index.js";
import { updateMemory, type Memory } from "../src/repositories/memory.js";
import {
  createMessageBatch,
  getMessagesByConversation,
  getNextSequenceNumber,
} from "../src/repositories/message.js";
import { createOrGetTurn } from "../src/repositories/turn.js";
import {
  createDocument,
  deleteDocument,
  searchDocuments,
} from "../src/repositories/document.js";
import { ConversationCreateSchema, ProfileSaveSchema } from "../src/schemas/memory-models.js";

class MemoryStatement {
  private args: unknown[] = [];

  constructor(
    private readonly sql: string,
    private readonly database: MemoryDatabase,
  ) {}

  bind(...args: unknown[]): MemoryStatement {
    this.args = args;
    return this;
  }

  async first<T>(): Promise<T | null> {
    if (!this.sql.startsWith("SELECT * FROM memories")) return null;
    const [id, userId] = this.args;
    const memory = this.database.memory;
    return (memory.id === id && (!userId || memory.user_id === userId)
      ? { ...memory }
      : null) as T | null;
  }

  async run(): Promise<{ meta: { rows_written: number } }> {
    if (this.sql.includes("SET content =")) {
      const [content, normalized, hash, category, importance, updatedAt, id, userId] = this.args;
      if (this.database.memory.id === id && this.database.memory.user_id === userId) {
        Object.assign(this.database.memory, {
          content,
          normalized_content: normalized,
          content_hash: hash,
          category,
          importance,
          updated_at: updatedAt,
          index_status: "pending",
        });
      }
    } else if (this.sql.includes("index_status = 'ready'")) {
      this.database.memory.index_status = "ready";
    }
    return { meta: { rows_written: 1 } };
  }
}

class MemoryDatabase {
  memory: Memory = {
    id: "mem-1",
    user_id: "owner",
    content: "old",
    normalized_content: "old",
    content_hash: "old-hash",
    category: "fact",
    importance: 3,
    source: "user_explicit",
    source_conversation_id: null,
    status: "active",
    index_status: "ready",
    embedding_model: "@cf/baai/bge-m3",
    embedding_version: 1,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    last_accessed_at: null,
    expires_at: null,
  };

  prepare(sql: string): MemoryStatement {
    return new MemoryStatement(sql, this);
  }
}

describe("Gateway authentication", () => {
  it("rejects every protected request when SERVICE_SECRET is missing", async () => {
    const response = await app.request(
      "http://gateway/",
      { headers: { Authorization: "Bearer " } },
      { SERVICE_SECRET: "" },
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "MEMORY_SERVICE_MISCONFIGURED" },
    });
  });

  it("accepts the configured bearer secret", async () => {
    const response = await app.request(
      "http://gateway/",
      { headers: { Authorization: "Bearer secret" } },
      { SERVICE_SECRET: "secret" },
    );

    expect(response.status).toBe(200);
  });

  it("returns the memory search shape consumed by both Agent clients", async () => {
    const response = await app.request(
      "http://gateway/internal/v1/users/user-1/memories:search",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query: "question" }),
      },
      {
        SERVICE_SECRET: "secret",
        DB: { prepare: vi.fn() },
        MEMORY_INDEX: { query: vi.fn().mockResolvedValue({ matches: [] }) },
        AI: { run: vi.fn().mockResolvedValue({ data: [[0.1, 0.2]] }) },
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      data: { items: [], degraded: false },
    });
  });
});

describe("Persistent identifiers and ordering", () => {
  it("creates the profile required by the conversation foreign key", async () => {
    const statements: string[] = [];
    const database = {
      prepare: (sql: string) => {
        statements.push(sql);
        return {
          bind: (...args: unknown[]) => ({
            first: async () => null,
            run: async () => ({ meta: { rows_written: 1 }, args }),
          }),
        };
      },
    };

    const response = await app.request(
      "http://gateway/internal/v1/conversations",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          id: "frontend-thread",
          user_id: "new-user",
          title: "Chat",
          mode: "chat",
        }),
      },
      { SERVICE_SECRET: "secret", DB: database },
    );

    expect(response.status).toBe(201);
    expect(statements.findIndex((sql) => sql.includes("INSERT INTO profiles")))
      .toBeLessThan(statements.findIndex((sql) => sql.includes("INSERT INTO conversations")));
  });

  it("classifies D1 constraint failures as data errors instead of AI outages", async () => {
    const database = {
      prepare: (sql: string) => ({
        bind: () => ({
          first: async () => null,
          run: async () => {
            if (sql.includes("INSERT INTO conversations")) {
              throw new Error(
                "D1_ERROR: FOREIGN KEY constraint FAILED: SQLITE_CONSTRAINT_FOREIGNKEY",
              );
            }
            return { meta: { rows_written: 1 } };
          },
        }),
      }),
    };

    const response = await app.request(
      "http://gateway/internal/v1/conversations",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ user_id: "new-user", title: "Chat" }),
      },
      { SERVICE_SECRET: "secret", DB: database },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "MEMORY_INVALID_REQUEST" },
    });
  });

  it("preserves a caller-provided conversation id", () => {
    expect(ConversationCreateSchema.parse({
      id: "frontend-thread",
      user_id: "user-1",
      title: "Chat",
      mode: "chat",
    }).id).toBe("frontend-thread");
  });

  it("accepts a preferences-only profile update without inventing an empty name", () => {
    expect(ProfileSaveSchema.parse({ preferences: { style: "concise" } })).toEqual({
      preferences: { style: "concise" },
    });
  });

  it("continues message sequences after the database maximum", async () => {
    const database = {
      prepare: () => ({
        bind: () => ({ first: async () => ({ next_sequence: 7 }) }),
      }),
    };

    await expect(getNextSequenceNumber(database as unknown as D1Database, "conv-1"))
      .resolves.toBe(7);
  });

  it("never replaces a different message that owns the same sequence", async () => {
    let preparedSql = "";
    const database = {
      prepare: (sql: string) => {
        preparedSql = sql;
        return { bind: () => ({ run: async () => ({}) }) };
      },
      batch: async () => [],
    };

    await createMessageBatch(database as unknown as D1Database, [{
      id: "message-1",
      conversation_id: "conv-1",
      user_id: "user-1",
      sequence_no: 7,
      role: "user",
      content_json: "hello",
      created_at: "2026-01-01T00:00:00.000Z",
    }]);

    expect(preparedSql).not.toContain("OR REPLACE");
    expect(preparedSql).toContain("ON CONFLICT(id)");
  });

  it("queries the newest message page in descending sequence order when requested", async () => {
    const statements: string[] = [];
    const database = {
      prepare: (sql: string) => {
        statements.push(sql);
        return {
          bind: () => ({
            all: async () => ({ results: [] }),
            first: async () => ({ cnt: 210 }),
          }),
        };
      },
    };

    await getMessagesByConversation(
      database as unknown as D1Database,
      "conv-1",
      200,
      0,
      "desc",
    );

    expect(statements[0]).toContain("ORDER BY sequence_no DESC");
  });

  it("reuses the existing Turn for the same conversation idempotency key", async () => {
    const existing = {
      id: "turn-existing",
      conversation_id: "conv-1",
      user_id: "user-1",
      client_message_id: "client-message-1",
      status: "completed",
      user_message_id: "message-1",
      assistant_message_id: "message-2",
      assistant_content_json: "answer",
      error_code: null,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      completed_at: "2026-01-01T00:00:00.000Z",
    };
    const database = {
      prepare: () => ({ bind: () => ({ first: async () => existing }) }),
    };

    const result = await createOrGetTurn(database as unknown as D1Database, {
      id: "turn-new",
      conversation_id: "conv-1",
      user_id: "user-1",
      client_message_id: "client-message-1",
    });

    expect(result).toEqual({ turn: existing, created: false });
  });
});

describe("Vector persistence", () => {
  it("schedules document compensation when embedding generation fails", async () => {
    const statements: string[] = [];
    const database = {
      prepare: (sql: string) => {
        statements.push(sql);
        return {
          bind: () => ({ run: async () => ({ meta: { rows_written: 1 } }) }),
        };
      },
    };
    const ai = { run: vi.fn().mockRejectedValue(new Error("AI unavailable")) };

    const result = await createDocument(
      database as unknown as D1Database,
      { upsert: vi.fn() } as unknown as VectorizeIndex,
      ai as unknown as Ai,
      {
        id: "doc-failed",
        user_id: "user-1",
        name: "doc.txt",
        filename: "doc.txt",
        file_type: "text/plain",
        size: 7,
        category: "general",
        content: "content",
      },
    );

    expect(result.degraded).toBe(true);
    expect(statements.some((sql) => sql.includes("INSERT INTO memory_index_jobs"))).toBe(true);
  });

  it("retains chunk vector ids until a failed document delete is compensated", async () => {
    const statements: string[] = [];
    const database = {
      prepare: (sql: string) => {
        statements.push(sql);
        return {
          bind: () => ({
            first: async () => sql.includes("SELECT * FROM documents")
              ? { id: "doc-delete", deleted_at: null }
              : null,
            all: async () => ({
              results: sql.includes("SELECT id, vectorize_id FROM chunks")
                ? [{ id: "chunk-1", vectorize_id: "vector-1" }]
                : [],
            }),
            run: async () => ({ meta: { rows_written: 1 } }),
          }),
        };
      },
    };
    const index = {
      deleteByIds: vi.fn().mockRejectedValue(new Error("Vectorize unavailable")),
    };

    await expect(deleteDocument(
      database as unknown as D1Database,
      index as unknown as VectorizeIndex,
      "doc-delete",
    )).resolves.toBe(true);

    expect(statements.some((sql) => sql.includes("INSERT INTO memory_index_jobs"))).toBe(true);
    expect(statements.some((sql) => sql.includes("DELETE FROM chunks"))).toBe(false);
  });

  it("rejects a cross-user memory update before touching Vectorize", async () => {
    const database = new MemoryDatabase();
    const index = { upsert: vi.fn() };
    const ai = { run: vi.fn().mockResolvedValue({ data: [[0.1, 0.2]] }) };

    const result = await updateMemory(
      database as unknown as D1Database,
      index as unknown as VectorizeIndex,
      ai as unknown as Ai,
      "attacker",
      "mem-1",
      { content: "stolen" },
    );

    expect(result).toBeNull();
    expect(index.upsert).not.toHaveBeenCalled();
  });

  it("re-embeds an owned memory and marks its index ready", async () => {
    const database = new MemoryDatabase();
    const index = { upsert: vi.fn().mockResolvedValue(undefined) };
    const ai = { run: vi.fn().mockResolvedValue({ data: [[0.1, 0.2]] }) };

    const result = await updateMemory(
      database as unknown as D1Database,
      index as unknown as VectorizeIndex,
      ai as unknown as Ai,
      "owner",
      "mem-1",
      { content: "new content", category: "preference" },
    );

    expect(index.upsert).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      content: "new content",
      category: "preference",
      index_status: "ready",
    });
  });

  it("maps prefixed Vectorize ids back to D1 chunk ids", async () => {
    const statements: string[] = [];
    const database = {
      prepare: (sql: string) => {
        statements.push(sql);
        return {
          bind: (...args: unknown[]) => ({
            all: async () => ({
              results: sql.includes("FROM chunks WHERE id IN") && args[0] === "doc-1:chunk_0"
                ? [{
                    id: "doc-1:chunk_0",
                    document_id: "doc-1",
                    user_id: "user-1",
                    chunk_index: 0,
                    content: "answer",
                    content_hash: "hash",
                    token_count: 2,
                    embedding_model: "model",
                    embedding_version: 1,
                    vectorize_id: "doc_doc-1:chunk_0",
                    created_at: "2026-01-01T00:00:00.000Z",
                  }]
                : sql.includes("FROM documents WHERE id IN")
                  ? [{ id: "doc-1", name: "Doc", filename: "doc.txt" }]
                  : [],
            }),
            first: async () => ({ name: "Doc", filename: "doc.txt" }),
          }),
        };
      },
    };
    const index = {
      query: vi.fn().mockResolvedValue({
        matches: [{ id: "doc_doc-1:chunk_0", score: 0.9 }],
      }),
    };
    const ai = { run: vi.fn().mockResolvedValue({ data: [[0.1, 0.2]] }) };

    const result = await searchDocuments(
      database as unknown as D1Database,
      index as unknown as VectorizeIndex,
      ai as unknown as Ai,
      "user-1",
      "question",
    );

    expect(result.results).toHaveLength(1);
    expect(result.results[0].id).toBe("doc-1:chunk_0");
    expect(statements.find((sql) => sql.includes("FROM chunks WHERE id IN")))
      .toContain("AND user_id = ?");
    expect(statements.find((sql) => sql.includes("FROM documents WHERE id IN")))
      .toContain("deleted_at IS NULL");
  });
});
