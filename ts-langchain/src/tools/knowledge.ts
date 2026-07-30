/**
 * knowledge.search — 企业知识库检索 Tool
 *
 * 将 RAG 检索封装为统一 Tool，接入 Runtime 管线。
 * 返回带文档引用（doc_id, page, score）的结构化结果。
 */

import { DynamicStructuredTool } from "langchain/tools";
import { z } from "zod";

import type { ToolDescriptor } from "./contracts.js";

// ============ 检索结果模型 ============

interface KnowledgeHit {
  doc_id: string;
  doc_name: string;
  content: string;
  score: number;
  page?: number;
  chunk_index?: number;
}

function hitsToText(hits: KnowledgeHit[], query: string): string {
  if (hits.length === 0) {
    return `📚 知识库中未找到与"${query}"相关的内容。`;
  }

  const lines: string[] = [`📚 知识库检索（${query}） — 找到 ${hits.length} 条相关结果：\n`];
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i];
    lines.push(`[${i + 1}] ${h.doc_name}`);
    if (h.page) {
      lines.push(`    页码：${h.page}`);
    } else if (h.chunk_index !== undefined) {
      lines.push(`    分段：${h.chunk_index + 1}`);
    }
    lines.push(`    相关度：${h.score.toFixed(2)}`);
    lines.push(`    ${h.content.slice(0, 200)}`);
    lines.push("");
  }

  return lines.join("\n");
}

// ============ Tool Descriptor ============

export const knowledgeSearchDescriptor: ToolDescriptor = {
  name: "knowledge.search",
  version: "1.0.0",
  title: "知识库检索",
  description:
    "在企业知识库中搜索相关信息。适用于需要从公司文档、产品手册、技术文档、FAQ 等内部资料中查找答案的场景。返回带文档来源和页码的引用。",
  category: "SEARCH",
  risk_level: "R1",
  side_effect: "read",
  timeout_ms: 15000,
  required_permissions: ["knowledge.search"],
  data_classification: ["internal"],
  owner: "rag",
  tags: ["rag", "knowledge", "search", "vector"],
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "检索关键词或问题，尽量简洁明确",
      },
      top_k: {
        type: "integer",
        description: "返回结果数量，默认 5，最大 10",
        default: 5,
        minimum: 1,
        maximum: 10,
      },
    },
    required: ["query"],
  },
};

// ============ LangChain Tool ============

export const knowledgeSearchTool: DynamicStructuredTool = new DynamicStructuredTool({
  name: "knowledge_search",
  description:
    "在企业知识库中搜索相关信息。适用于需要从公司文档、产品手册、技术文档等内部资料中查找答案的场景。返回带文档来源和页码的引用。",
  schema: z.object({
    query: z.string().describe("检索关键词或问题，尽量简洁明确"),
    top_k: z.number().int().min(1).max(10).default(5).describe("返回结果数量，默认 5"),
  }),
  func: async ({ query, top_k }) => {
    try {
      // 动态导入，避免循环依赖
      const { Retriever } = await import("../rag/retriever.js");

      const retriever = new Retriever({
        qdrantUrl: process.env.QDRANT_URL || "http://localhost:6333",
        collectionName: "documents",
        topK: top_k || 5,
      });

      const results = await retriever.retrieve(query);

      if (!results || results.length === 0) {
        return `📚 知识库中未找到与"${query}"相关的内容。`;
      }

      const hits: KnowledgeHit[] = results.map((r) => {
        const meta = r.metadata || {};
        return {
          doc_id: meta.source || "unknown",
          doc_name: meta.filename || "未知文档",
          content: r.content || "",
          score: r.score || 0,
          chunk_index: meta.chunkIndex,
        };
      });

      return hitsToText(hits, query);
    } catch (error) {
      return `📚 知识库检索暂时不可用：${error instanceof Error ? error.message : "未知错误"}`;
    }
  },
});
