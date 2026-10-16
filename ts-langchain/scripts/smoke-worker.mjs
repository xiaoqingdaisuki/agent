import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const baseUrl = process.env.WORKER_TEST_URL;
assert(baseUrl, "Set WORKER_TEST_URL to the local or deployed Worker URL");
assert(process.env.AGENT_API_SECRET, "AGENT_API_SECRET is required");
const userId = `worker-smoke-${randomUUID()}`;
const headers = {
  "User-Agent": "agent-worker-smoke/1.0",
  Authorization: `Bearer ${process.env.AGENT_API_SECRET}`,
  "x-agent-user-id": userId,
};
let conversationId;
let documentId;

// 调用真实 Worker API，发生错误时只输出状态和业务错误，不输出认证信息。
async function request(path, init = {}) {
  const safeToRetry = !init.method || path === "/v1/knowledge/search";
  for (let attempt = 0; ; attempt++) {
    let response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        ...init,
        headers: { ...headers, ...init.headers },
        signal: AbortSignal.timeout(180_000),
      });
    } catch (error) {
      if (!safeToRetry || attempt >= 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
      continue;
    }
    assert(response.ok, `${path}: ${response.status} ${await response.clone().text()}`);
    return response;
  }
}

// 为 JSON API 编码请求体并读取响应。
async function jsonRequest(path, body) {
  return (await request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })).json();
}

try {
  const readiness = await (await request("/v1/health/ready")).json();
  assert.equal(readiness.ready, true);
  const unauthenticated = await fetch(`${baseUrl}/v1/capabilities`, { headers: { "User-Agent": headers["User-Agent"] } });
  assert.equal(unauthenticated.status, 401);
  console.log("PASS readiness and authentication");

  const conversation = await jsonRequest("/v1/conversations", { title: "Worker production smoke" });
  conversationId = conversation.id;
  const reply = await jsonRequest(`/v1/conversations/${conversationId}/messages`, {
    content: "请用一句话说明为什么天空通常是蓝色的。", client_message_id: randomUUID(),
  });
  assert(reply.content?.length > 0, "Model response is empty");
  const messages = await (await request(`/v1/conversations/${conversationId}/messages`)).json();
  assert(JSON.stringify(messages).includes(reply.content), "Model response was not persisted");
  console.log("PASS real model chat and durable message readback");

  const stream = await request(`/v1/conversations/${conversationId}/messages/stream`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: "把刚才的说明缩短成十个字以内。", client_message_id: randomUUID() }),
  });
  assert(stream.headers.get("content-type")?.includes("text/event-stream"));
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let streamText = "";
  let receivedBeforeEnd = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    streamText += decoder.decode(value, { stream: true });
    if (streamText.includes("event: text") && !streamText.includes("[DONE]")) receivedBeforeEnd = true;
  }
  assert(streamText.includes("event: text"), "SSE text is missing");
  assert(!streamText.includes("event: error"), "SSE returned an error");
  assert(streamText.includes("[DONE]"), "SSE did not complete");
  assert(receivedBeforeEnd, "SSE was buffered until completion");
  console.log("PASS incremental SSE response");

  const marker = `RAG-${randomUUID()}`;
  const form = new FormData();
  form.append("file", new Blob([`星桥项目的上线口令为 ${marker}，验证负责人是林舟。`]), "worker-smoke.txt");
  const document = await (await request("/v1/knowledge/documents", { method: "POST", body: form })).json();
  documentId = document.id;
  assert.equal(document.status, "indexed", "Document embedding/indexing failed");
  let found = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    const results = await jsonRequest("/v1/knowledge/search", { query: "星桥项目的上线口令是什么", top_k: 5 });
    found = JSON.stringify(results).includes(marker);
    if (found) break;
    if (attempt % 6 === 0) console.log("Waiting for Vectorize indexing visibility...");
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  assert(found, "Uploaded document was not retrieved");
  const ragReply = await jsonRequest(`/v1/conversations/${conversationId}/messages`, {
    content: "星桥项目的上线口令是什么？请按文档原样回答。", client_message_id: randomUUID(),
  });
  assert(ragReply.content.includes(marker), "RAG answer did not use the uploaded document");
  console.log("PASS document embedding, search and grounded model answer");

  const isolated = await fetch(`${baseUrl}/v1/knowledge/documents/${documentId}`, {
    headers: { ...headers, "x-agent-user-id": `${userId}-other` },
  });
  assert.equal(isolated.status, 404);
  console.log("PASS cross-user document isolation");
} finally {
  if (documentId) await request(`/v1/knowledge/documents/${documentId}`, { method: "DELETE" });
  if (conversationId) await request(`/v1/conversations/${conversationId}`, { method: "DELETE" });
  console.log("Smoke documents and conversations cleaned up");
}
