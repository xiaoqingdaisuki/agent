/**
 * memory.session — 会话记忆管理
 *
 * 提供当前会话/对话的上下文检索能力。
 */

import { DynamicStructuredTool } from "langchain/tools";
import { z } from "zod";

import type { ToolDescriptor } from "./contracts.js";

// ============ 会话记忆存储 ============

interface SessionMessage {
  role: "user" | "assistant";
  content: string;
}

class SessionMemoryStore {
  private sessions = new Map<string, SessionMessage[]>();

  get(conversationId: string): SessionMessage[] {
    return this.sessions.get(conversationId) || [];
  }

  add(conversationId: string, role: "user" | "assistant", content: string): void {
    const messages = this.sessions.get(conversationId) || [];
    messages.push({ role, content });
    this.sessions.set(conversationId, messages);
  }

  clear(conversationId: string): void {
    this.sessions.delete(conversationId);
  }

  search(conversationId: string, query: string, maxResults: number = 5): SessionMessage[] {
    const messages = this.sessions.get(conversationId) || [];
    if (!query) return messages.slice(-maxResults);

    const queryLower = query.toLowerCase();
    const results: SessionMessage[] = [];
    for (const msg of messages) {
      if (msg.content.toLowerCase().includes(queryLower)) {
        results.push(msg);
        if (results.length >= maxResults) break;
      }
    }
    return results;
  }
}

export const sessionStore = new SessionMemoryStore();

// ============ Tool Descriptor ============

export const sessionMemoryDescriptor: ToolDescriptor = {
  name: "memory.session.search",
  version: "1.0.0",
  title: "会话记忆搜索",
  description:
    "在当前会话中搜索之前的对话内容。当需要回顾用户之前说过的话、或查找之前的回答时使用。返回匹配的对话片段。",
  category: "MEMORY",
  risk_level: "R1",
  side_effect: "read",
  timeout_ms: 5000,
  required_permissions: ["memory.session.read"],
  data_classification: ["internal"],
  owner: "memory",
  tags: ["memory", "session", "conversation"],
  input_schema: {
    type: "object",
    properties: {
      conversation_id: {
        type: "string",
        description: "会话 ID，用于标识当前对话",
      },
      query: {
        type: "string",
        description: "搜索关键词，留空则返回最近的对话",
        default: "",
      },
      max_results: {
        type: "integer",
        description: "最多返回几条结果",
        default: 5,
        maximum: 20,
      },
    },
    required: ["conversation_id"],
  },
};

// ============ LangChain Tool ============

export const memorySessionSearchTool: DynamicStructuredTool = new DynamicStructuredTool({
  name: "memory_session_search",
  description:
    "在当前会话中搜索之前的对话内容。当需要回顾用户之前说过的话或查找之前的回答时使用。",
  schema: z.object({
    conversation_id: z.string().describe("会话 ID"),
    query: z.string().default("").describe("搜索关键词，留空返回最近对话"),
    max_results: z.number().int().min(1).max(20).default(5).describe("最多返回条数"),
  }),
  func: async ({ conversation_id, query, max_results }) => {
    const results = sessionStore.search(conversation_id, query || "", max_results || 5);

    if (results.length === 0) {
      return "📝 当前会话中未找到相关内容。";
    }

    const lines: string[] = [`📝 会话记忆（${conversation_id}）— ${results.length} 条：\n`];
    for (let i = 0; i < results.length; i++) {
      const msg = results[i];
      const role = msg.role === "user" ? "用户" : "助手";
      lines.push(`[${i + 1}] ${role}：${msg.content.slice(0, 200)}`);
      lines.push("");
    }

    return lines.join("\n");
  },
});
