import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../../src/api/index.js";
import { config } from "../../src/config/index.js";
import { AgentService, ConversationService, TurnService, BusinessError } from "../../src/services/index.js";
import { parseSessionDocument } from "../../src/services/session-documents.js";

describe("verified API regressions", () => {
  it.each([false, true])("releases a disconnected stream Turn (legacy=%s)", async (legacy) => {
    const memoryEnabled = config.MEMORY_ENABLED;
    config.MEMORY_ENABLED = false;
    const user = `disconnect-${crypto.randomUUID()}`;
    const conversation = await ConversationService.create("disconnect", "chat", user);
    const stream = vi.spyOn(AgentService, "chatStream").mockImplementation(async function* (_id, _content, _user, signal) {
      await new Promise<void>((_resolve, reject) => {
        if (signal?.aborted) reject(signal.reason);
        else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      yield { type: "text", text: "unreachable" };
    });
    const app = await buildApp();
    const controller = new AbortController();
    try {
      const address = await app.listen({ port: 0, host: "127.0.0.1" });
      const response = await fetch(`${address}${legacy ? "/stream" : `/api/v1/conversations/${conversation.id}/messages/stream`}`, {
        method: "POST", headers: { "content-type": "application/json", authorization: "Bearer test-agent-secret", "x-agent-user-id": user },
        body: JSON.stringify(legacy ? { message: "question", thread_id: conversation.id } : { content: "question" }), signal: controller.signal,
      });
      const reader = response.body!.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain("event: meta");
      controller.abort();
      await reader.cancel().catch(() => undefined);
      await vi.waitFor(async () => {
        const result = await TurnService.begin(conversation.id, user, "next", "second");
        expect(result.created).toBe(true);
      });
    } finally {
      controller.abort();
      await app.close();
      stream.mockRestore();
      config.MEMORY_ENABLED = memoryEnabled;
    }
  });

  it.each([false, true])("settles an upstream error before delivering it (legacy=%s)", async (legacy) => {
    const memoryEnabled = config.MEMORY_ENABLED;
    config.MEMORY_ENABLED = false;
    const user = `failed-${crypto.randomUUID()}`;
    const conversation = await ConversationService.create("failed", "chat", user);
    const stream = vi.spyOn(AgentService, "chatStream").mockImplementation(async function* () {
      throw new BusinessError("MODEL_RESPONSE_INVALID", "invalid response", 502);
      yield { type: "text", text: "unreachable" };
    });
    const app = await buildApp();
    try {
      const response = await app.inject({ method: "POST", url: legacy ? "/stream" : `/api/v1/conversations/${conversation.id}/messages/stream`,
        headers: { authorization: "Bearer test-agent-secret", "x-agent-user-id": user },
        payload: legacy ? { message: "question", thread_id: conversation.id } : { content: "question" },
      });
      expect(response.body).toContain("MODEL_RESPONSE_INVALID");
      expect((await TurnService.begin(conversation.id, user, "next", "second")).created).toBe(true);
    } finally {
      await app.close();
      stream.mockRestore();
      config.MEMORY_ENABLED = memoryEnabled;
    }
  });
  it("preserves Unicode document parts when sending parsed attachments as JSON", async () => {
    const memoryEnabled = config.MEMORY_ENABLED;
    config.MEMORY_ENABLED = false;
    const user = `unicode-${crypto.randomUUID()}`;
    const text = "A".repeat(19_999) + "😀TAIL";
    const document = await parseSessionDocument(Buffer.from(text), "unicode.txt");
    const conversation = await ConversationService.create("Unicode document", "chat", user);
    const chat = vi.spyOn(AgentService, "chat").mockResolvedValue({
      id: crypto.randomUUID(), role: "assistant", content: "已读取", createdAt: new Date().toISOString(),
    });
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: "POST", url: `/api/v1/conversations/${conversation.id}/messages`,
        headers: { authorization: "Bearer test-agent-secret", "x-agent-user-id": user },
        payload: { content: "请读取附件", client_message_id: "unicode-one", session_documents: [document] },
      });
      expect(response.statusCode).toBe(200);
      expect(chat.mock.calls[0][4]?.sessionDocuments?.[0].parts.map((part) => part.content).join("")).toBe(text);
    } finally {
      await app.close();
      chat.mockRestore();
      config.MEMORY_ENABLED = memoryEnabled;
    }
  });

  it.each(["GET", "PATCH", "DELETE"])("permits unauthenticated CORS preflight for %s", async (method) => {
    const origins = config.CORS_ORIGIN;
    config.CORS_ORIGIN = ["https://audit.example"];
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: "OPTIONS", url: "/api/v1/profile",
        headers: { origin: "https://audit.example", "access-control-request-method": method,
          "access-control-request-headers": "authorization,x-agent-user-id" },
      });
      expect(response.statusCode).toBe(204);
      expect(response.headers["access-control-allow-origin"]).toBe("https://audit.example");
      expect(String(response.headers["access-control-allow-methods"]).split(",").map((value) => value.trim())).toContain(method);
    } finally {
      await app.close();
      config.CORS_ORIGIN = origins;
    }
  });
});
