import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../../src/api/index.js";
import { config } from "../../src/config/index.js";
import { AgentService, ConversationService } from "../../src/services/index.js";
import { parseSessionDocument } from "../../src/services/session-documents.js";

describe("verified API regressions", () => {
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
