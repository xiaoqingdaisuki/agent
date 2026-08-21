import { describe, expect, it } from "vitest";

import { tools } from "../../src/tools/index.js";
import { registry } from "../../src/tools/registry.js";
import {
  currentTimeTool,
  convertTimezoneTool,
} from "../../src/tools/time.js";
import { extractStructuredItems } from "../../src/tools/web-extract.js";
import { fileSearchTool } from "../../src/tools/file-search.js";
import {
  memoryUserSaveTool,
  memoryUserListTool,
  memoryUserDeleteTool,
} from "../../src/tools/memory-user.js";
import { runWithToolCallContext } from "../../src/tools/runtime/executor.js";

const V2_DESCRIPTOR_NAMES = [
  "time.current",
  "time.convert",
  "file.search",
  "web.extract",
  "memory.user.list",
  "memory.user.delete",
];

describe("Agent Tools V2", () => {
  it("registers all six new descriptors and exposes 15 tools", () => {
    const descriptors = registry.getDescriptors().map((descriptor) => descriptor.name);
    expect(descriptors).toEqual(expect.arrayContaining(V2_DESCRIPTOR_NAMES));
    expect(descriptors).toHaveLength(descriptors.includes("knowledge.search") ? 15 : 14);
    expect(tools).toHaveLength(descriptors.includes("knowledge.search") ? 15 : 14);
  });

  it("returns current time in the requested timezone", async () => {
    const result = JSON.parse(await currentTimeTool.invoke({ timezone: "Asia/Shanghai" }));
    expect(result.timezone).toBe("Asia/Shanghai");
    expect(result.datetime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/);
    expect(result.weekday).toMatch(/^[A-Z][a-z]+$/);
  });

  it("converts timezone with DST-aware IANA rules", async () => {
    const result = JSON.parse(await convertTimezoneTool.invoke({
      datetime: "2026-08-21T15:00:00",
      from_timezone: "Asia/Shanghai",
      to_timezone: "America/New_York",
    }));
    expect(result.datetime).toBe("2026-08-21T03:00:00-04:00");
    expect(result.timezone).toBe("America/New_York");
  });

  it("extracts fields from repeated product cards", () => {
    const html = `
      <div class="product"><span class="name">Product A</span><span class="price">99</span><span class="rating">4.8</span></div>
      <div class="product"><span class="name">Product B</span><span class="price">129</span><span class="rating">4.6</span></div>`;
    expect(extractStructuredItems(html, ["name", "price", "rating"])).toEqual([
      { name: "Product A", price: "99", rating: "4.8" },
      { name: "Product B", price: "129", rating: "4.6" },
    ]);
  });

  it("searches files within the trusted user scope and preserves location", async () => {
    const result = await runWithToolCallContext(
      {
        request_id: "req-test",
        trace_id: "trace-test",
        conversation_id: "conv-test",
        tenant_id: "tenant-test",
        user_id: "user-test",
        actor_type: "user",
      },
      () => fileSearchTool.invoke({ query: "提前终止", file_ids: ["file_123"], top_k: 5 }),
    );
    const parsed = JSON.parse(result);
    expect(parsed.results[0]).toEqual(expect.objectContaining({
      file_id: "file_123",
      filename: "contract.pdf",
      position: 18,
      text: expect.stringContaining("30日"),
    }));
  });

  it("lists and deletes memory only by exact IDs", async () => {
    const context = {
      request_id: "req-memory",
      trace_id: "trace-memory",
      conversation_id: "conv-memory",
      tenant_id: "tenant-test",
      user_id: "v2-memory-user",
      actor_type: "user" as const,
    };
    await memoryUserSaveTool.invoke({ user_id: context.user_id, content: "用户偏好简洁回答", category: "preference" });
    const listed = JSON.parse(await runWithToolCallContext(context, () => memoryUserListTool.invoke({})));
    expect(listed.memories).toEqual([
      { memory_id: expect.any(String), content: "用户偏好简洁回答", category: "preference" },
    ]);
    const deleted = JSON.parse(await runWithToolCallContext(
      context,
      () => memoryUserDeleteTool.invoke({ memory_ids: [listed.memories[0].memory_id] }),
    ));
    expect(deleted.deleted).toEqual([listed.memories[0].memory_id]);
  });
});
