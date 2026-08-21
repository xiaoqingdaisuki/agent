/**
 * file.search — 用户文件内容检索
 *
 * 通过文档向量索引先定位相关文件片段，并保留文件标识、文件名和位置。
 */

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";

import type { ToolDescriptor } from "./contracts.js";
import { CloudflareMemoryClient } from "../clients/memory_gateway.js";
import { getToolCallContext } from "./runtime/executor.js";

export const fileSearchInputSchema = z.object({
  query: z.string().min(1).max(500).describe("要搜索的文件内容或问题"),
  file_ids: z.array(z.string().min(1).max(128)).max(20).default([]).describe("限定搜索的文件 ID，可留空搜索当前用户的全部文件"),
  top_k: z.number().int().min(1).max(20).default(5).describe("返回结果数量"),
});

export const fileSearchDescriptor: ToolDescriptor = {
  name: "file.search",
  version: "1.0.0",
  title: "文件内容搜索",
  description:
    "先在当前用户的文件内容中搜索相关片段，返回文件 ID、文件名、页码或位置和原文片段。适合大型 PDF、Word、TXT 等文件的定位，不用于读取全文。",
  category: "SEARCH",
  risk_level: "R1",
  side_effect: "read",
  timeout_ms: 15000,
  required_permissions: ["file.search"],
  data_classification: ["internal"],
  owner: "tools",
  tags: ["file", "search", "document", "rag"],
  input_schema: fileSearchInputSchema,
};

// 将文档搜索结果转换为 file.search 的稳定 JSON 输出。
function formatFileSearchResults(
  results: Array<{ document_id: string; chunk_index: number; content: string; metadata?: Record<string, unknown> }>,
  degraded: boolean,
): string {
  return JSON.stringify({
    results: results.map((result) => ({
      file_id: result.document_id,
      filename:
        typeof result.metadata?.filename === "string"
          ? result.metadata.filename
          : typeof result.metadata?.document_name === "string"
            ? result.metadata.document_name
            : "",
      page: typeof result.metadata?.page === "number" ? result.metadata.page : null,
      position: result.chunk_index + 1,
      text: result.content,
    })),
    degraded,
  });
}

export const fileSearchTool: DynamicStructuredTool = new DynamicStructuredTool({
  name: "file_search",
  description:
    "搜索当前用户文件中的相关内容，返回文件 ID、文件名、位置和原文片段。大型文件应先搜索再读取。",
  schema: fileSearchInputSchema,
  func: async ({ query, file_ids, top_k }) => {
    const userId = getToolCallContext()?.user_id;
    if (!userId) {
      return JSON.stringify({ error: "缺少可信用户上下文，无法搜索用户文件" });
    }

    try {
      const client = new CloudflareMemoryClient();
      const result = await client.searchDocuments(userId, query, {
        limit: top_k || 5,
        minScore: 0,
        documentIds: file_ids?.length ? file_ids : undefined,
      });
      return formatFileSearchResults(result.results, result.degraded);
    } catch (error) {
      return JSON.stringify({
        results: [],
        error: `文件搜索暂时不可用：${error instanceof Error ? error.message : "未知错误"}`,
      });
    }
  },
});

