import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../../src/api/index.js";
import { KnowledgeService } from "../../src/services/index.js";

describe("knowledge upload API", () => {
  afterEach(() => vi.restoreAllMocks());

  it("accepts multipart form data", async () => {
    vi.spyOn(KnowledgeService, "uploadDocument").mockResolvedValue({
      id: "doc-1",
      name: "note.txt",
      size: 5,
      status: "indexed",
      chunks: 1,
      createdAt: new Date().toISOString(),
    });
    const boundary = "test-boundary";
    const payload = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="note.txt"\r\n` +
      `Content-Type: text/plain\r\n\r\nhello\r\n--${boundary}--\r\n`,
    );
    const app = await buildApp();
    const originalInject = app.inject.bind(app);
    app.inject = ((options: any) => originalInject({
      ...options,
      headers: {
        authorization: "Bearer test-agent-secret",
        "x-agent-user-id": "upload-user",
        ...options.headers,
      },
    })) as typeof app.inject;
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/knowledge/documents",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload,
    });
    await app.close();

    expect(response.statusCode).toBe(201);
    expect(response.json().name).toBe("note.txt");
  });
});
