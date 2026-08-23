/**
 * memory.session — 会话记忆管理
 *
 * 提供当前会话/对话的上下文检索能力。
 * 统一通过 Repository 层访问当前配置的存储后端。
 */

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";

import type { ToolDescriptor } from "./contracts.js";
import { getRepositories } from "../repositories/index.js";
import { config } from "../config/index.js";

// ============ Tool Descriptor ==========

export const sessionMemorySearchInputSchema = z.object({
  conversation_id: z.string().describe("会话 ID，用于标识当前对话"),
  query: z.string().default("").describe("搜索关键词，留空则返回最近的对话"),
  max_results: z.number().int().min(1).max(20).default(5).describe("最多返回几条结果"),
});

export const sessionMemoryDescriptor: ToolDescriptor = {
  name: "memory.session.search",
  version: "1.0.0",
  title: "会话记忆搜索",
  description:
    "在当前会话中搜索之前的对话内容。当需要回顾用户之前说过的话或查找之前的回答时使用。返回匹配的对话片段。",
  category: "MEMORY",
  risk_level: "R1",
  side_effect: "read",
  timeout_ms: 5000,
  required_permissions: ["memory.session.read"],
  data_classification: ["internal"],
  owner: "memory",
  tags: ["memory", "session", "conversation"],
  input_schema: sessionMemorySearchInputSchema,
};

// ============ LangChain Tool ==========

export const memorySessionSearchTool: DynamicStructuredTool =
  new DynamicStructuredTool({
    name: "memory_session_search",
    description:
      "在当前会话中搜索之前的对话内容。当需要回顾用户之前说过的话或查找之前的回答时使用。",
    schema: sessionMemorySearchInputSchema,
  func: async ({ conversation_id, query, max_results }) => {
    const repos = getRepositories();
    const maxResults = max_results || 5;

    try {
      // 从 Repository 获取会话消息
      const result = await repos.message.getMessages(
        conversation_id,
        Math.min(maxResults * 5, 100),
        0,
      );

      let messages = result.messages;

      // 关键词过滤
      if (query) {
        const queryLower = query.toLowerCase();
        messages = messages.filter((m: any) => {
          const content = typeof m.content_json === "string"
            ? m.content_json
            : JSON.stringify(m.content_json);
          return content.toLowerCase().includes(queryLower);
        });
      }

      // 取最近 N 条
      messages = messages.slice(-maxResults);

      if (messages.length === 0) {
        return "📝 当前会话中未找到相关内容。";
      }

      const lines: string[] = [
        `📝 会话记忆（${conversation_id}）— ${messages.length} 条：\n`,
      ];
      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        const content = typeof msg.content_json === "string"
          ? msg.content_json
          : JSON.stringify(msg.content_json);
        const roleLabel = msg.role === "user" ? "用户" : msg.role === "assistant" ? "助手" : msg.role;
        lines.push(`[${i + 1}] ${roleLabel}：${content.slice(0, 200)}`);
        lines.push("");
      }

      return lines.join("\n");
    } catch {
      return "📝 会话记忆查询失败。";
    }
  },
  });
