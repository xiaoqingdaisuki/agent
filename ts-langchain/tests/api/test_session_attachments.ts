import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../../src/api/index.js";
import { config } from "../../src/config/index.js";
import { AgentService, KnowledgeService } from "../../src/services/index.js";
import { parseSessionDocument } from "../../src/services/session-documents.js";

function buildPdfFixture(): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Length 59 >>\nstream\nBT\n/F1 18 Tf\n72 720 Td\n(PDF-TS-MARKER-421) Tj\nET\nendstream",
  ];
  let result = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(result));
    result += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(result);
  result += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  result += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  result += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(result, "latin1");
}

function buildDocxFixture(): Buffer {
  return Buffer.from(
    "UEsDBBQAAAAIAI+JKV15bjPX7AAAAK0BAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbH2Qy07DMBBFf8XyFsUOLBBCcbrgsQQW5QMse5JYtWcsjxvSv0dpSxeosL6Pc3W7zZKimKFwIDTyVrVSADryAUcjP7evzYMUXC16GwnByAOw3PTd9pCBxZIispFTrflRa3YTJMuKMuCS4kAl2cqKyqizdTs7gr5r23vtCCtgberaIfvuGQa7j1W8LBXwtKNAZCmeTsaVZaTNOQZnayDUM/pflOZMUAXi0cNTyHyzpCj1VcKq/A04595nKCV4EB+21DebwEj9RcVrT26fAKv6v+bKThqG4OCSX9tyIQfMAccU1UVJNuDPfn28u/8GUEsDBBQAAAAIAI+JKV2b/TfqsQAAACkBAAALAAAAX3JlbHMvLnJlbHONz8FqwzAQBNBfEXuv5eQQQrDsSwjkWtwPENLaFpV2hVZNnb/PJYc49NDrMLxhumFNUd2wSGAysGtaUEiOfaDZwNd4+TiCkmrJ28iEBu4oMPTdJ0ZbA5MsIYtaUyQxsNSaT1qLWzBZaTgjrSlOXJKt0nCZdbbu286o92170OXVgK2prt5AufodqPGe8T82T1NweGb3k5DqHxNvDVCjLTNWA79cvPbPuFlTBN13enOxfwBQSwMEFAAAAAgAj4kpXZINvqqpAAAA2AAAABEAAAB3b3JkL2RvY3VtZW50LnhtbEXOzQqDMBAE4FeR3DXWg4iopfTnUkpBWug1NakKyW7IplXfvsQeevkGFmbYajsbHX2UoxGhZpskZZGCDuUIfc3ut1NcsIi8ACk0gqrZoohtm2oqJXZvo8BHs9FA5VSzwXtbck7doIygBK2C2egXOiM8Jeh6PqGT1mGniEbojeZZmubciBFYmHyiXELagAv45nDdP+LLrj0f27jIs4qHY9Ct2tVfkf+far5QSwECFAAUAAAACACPiSldeW4z1+wAAACtAQAAEwAAAAAAAAAAAAAAgAEAAAAAW0NvbnRlbnRfVHlwZXNdLnhtbFBLAQIUABQAAAAIAI+JKV2b/TfqsQAAACkBAAALAAAAAAAAAAAAAACAAR0BAABfcmVscy8ucmVsc1BLAQIUABQAAAAIAI+JKV2SDb6qqQAAANgAAAARAAAAAAAAAAAAAACAAfcBAAB3b3JkL2RvY3VtZW50LnhtbFBLBQYAAAAAAwADALkAAADPAgAAAAA=",
    "base64",
  );
}

describe("session attachment API", () => {
  const originalMemoryEnabled = config.MEMORY_ENABLED;

  afterEach(() => {
    (config as { MEMORY_ENABLED: boolean }).MEMORY_ENABLED = originalMemoryEnabled;
    vi.restoreAllMocks();
  });

  it("parses PDF and DOCX buffers with third-party loaders", async () => {
    const pdf = await parseSessionDocument(buildPdfFixture(), "marker.pdf", "application/pdf");
    const docx = await parseSessionDocument(
      buildDocxFixture(),
      "marker.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );

    expect(pdf.parts[0]?.content).toContain("PDF-TS-MARKER-421");
    expect(pdf.parts[0]?.page).toBe(1);
    expect(docx.parts[0]?.content).toContain("DOCX-MARKER-862");
  });

  it("parses temporary documents and passes them to the current turn only", async () => {
    (config as { MEMORY_ENABLED: boolean }).MEMORY_ENABLED = false;
    const chat = vi.spyOn(AgentService, "chat").mockResolvedValue({
      id: "assistant-1",
      role: "assistant",
      content: "已根据附件完成分析",
      createdAt: new Date().toISOString(),
    });
    const app = await buildApp();
    const request = (options: any) => app.inject({
      ...options,
      headers: {
        authorization: "Bearer test-agent-secret",
        "x-agent-user-id": "session-user",
        ...options.headers,
      },
    });
    const created = await request({
      method: "POST",
      url: "/api/v1/conversations",
      payload: { title: "临时附件", user_id: "session-user" },
    });
    const conversationId = created.json().id;
    const boundary = "session-document-boundary";
    const parsed = await request({
      method: "POST",
      url: `/api/v1/conversations/${conversationId}/session-documents/parse`,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="rules.md"\r\n` +
        "Content-Type: text/markdown\r\n\r\n第一条规则\r\n\r\n第二条规则\r\n" +
        `--${boundary}--\r\n`,
      ),
    });
    expect(parsed.statusCode).toBe(200);
    const document = parsed.json();

    const response = await request({
      method: "POST",
      url: `/api/v1/conversations/${conversationId}/messages`,
      payload: {
        content: "请总结规则",
        user_id: "session-user",
        client_message_id: "temporary-document-turn",
        session_documents: [document],
      },
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(chat).toHaveBeenCalledWith(
      conversationId,
      "请总结规则",
      "session-user",
      expect.any(Object),
      expect.objectContaining({
        sessionDocuments: [expect.objectContaining({ filename: "rules.md" })],
        images: [],
      }),
    );
  });

  it("deduplicates identical images in the request context", async () => {
    (config as { MEMORY_ENABLED: boolean }).MEMORY_ENABLED = false;
    const upload = vi.spyOn((await import("../../src/services/index.js")).KnowledgeService, "uploadDocument");
    const chat = vi.spyOn(AgentService, "chat").mockResolvedValue({
      id: "assistant-2",
      role: "assistant",
      content: "图片已收到",
      createdAt: new Date().toISOString(),
    });
    const app = await buildApp();
    const request = (options: any) => app.inject({
      ...options,
      headers: {
        authorization: "Bearer test-agent-secret",
        "x-agent-user-id": "image-user",
        ...options.headers,
      },
    });
    const created = await request({
      method: "POST",
      url: "/api/v1/conversations",
      payload: { title: "临时图片", user_id: "image-user" },
    });
    const conversationId = created.json().id;
    const boundary = "image-message-boundary";
    const response = await request({
      method: "POST",
      url: `/api/v1/conversations/${conversationId}/messages`,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n` +
        JSON.stringify({ content: "请描述图片", user_id: "image-user", client_message_id: "temporary-image-turn" }) +
        `\r\n--${boundary}\r\nContent-Disposition: form-data; name="images"; filename="diagram.png"\r\n` +
        "Content-Type: image/png\r\n\r\nPNGDATA\r\n" +
        `--${boundary}\r\nContent-Disposition: form-data; name="images"; filename="diagram.png"\r\n` +
        "Content-Type: image/png\r\n\r\nPNGDATA\r\n" +
        `--${boundary}--\r\n`,
      ),
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(upload).not.toHaveBeenCalled();
    expect(chat.mock.calls[0]?.[4]).toEqual(expect.objectContaining({
      images: [expect.objectContaining({ mimeType: "image/png" })],
    }));
  });

  it("persists document attachments and binds their ids to the agent turn when memory is enabled", async () => {
    (config as { MEMORY_ENABLED: boolean }).MEMORY_ENABLED = true;
    const upload = vi.spyOn(KnowledgeService, "uploadDocument").mockResolvedValue({
      id: "doc-persisted",
      name: "policy.md",
      size: 12,
      status: "indexed",
      chunks: 1,
      createdAt: new Date().toISOString(),
    });
    const chat = vi.spyOn(AgentService, "chat").mockResolvedValue({
      id: "assistant-3",
      role: "assistant",
      content: "已纳入知识库",
      createdAt: new Date().toISOString(),
    });
    const app = await buildApp();
    const request = (options: any) => app.inject({
      ...options,
      headers: {
        authorization: "Bearer test-agent-secret",
        "x-agent-user-id": "persistent-user",
        ...options.headers,
      },
    });
    const created = await request({
      method: "POST",
      url: "/api/v1/conversations",
      payload: { title: "持久化附件", user_id: "persistent-user" },
    });
    const conversationId = created.json().id;
    const response = await request({
      method: "POST",
      url: `/api/v1/conversations/${conversationId}/messages`,
      payload: {
        content: "后续回答请参考政策",
        user_id: "persistent-user",
        client_message_id: "persistent-document-turn",
        session_documents: [{
          localId: "local-policy",
          filename: "policy.md",
          mimeType: "text/markdown",
          size: 12,
          parserVersion: "test",
          parts: [{ partIndex: 0, page: 1, content: "提前三十日通知" }],
        }],
      },
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(upload).toHaveBeenCalledWith(expect.any(Buffer), "policy.md", undefined, "persistent-user", "提前三十日通知");
    expect(chat.mock.calls[0]?.[4]).toEqual(expect.objectContaining({ documentIds: ["doc-persisted"] }));
  });
});
