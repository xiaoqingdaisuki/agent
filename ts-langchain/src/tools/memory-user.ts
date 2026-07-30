/**
 * memory.user — 用户长期记忆管理
 *
 * 提供用户记忆的搜索和保存能力。
 */

import { DynamicStructuredTool } from "langchain/tools";
import { z } from "zod";

import type { ToolDescriptor } from "./contracts.js";

// ============ 用户记忆存储 ============

interface UserMemory {
  id: string;
  user_id: string;
  content: string;
  category: string;
  importance: number;
  created_at: string;
  updated_at: string;
  source: string;
}

class UserMemoryStore {
  private memories = new Map<string, UserMemory[]>();

  add(userId: string, content: string, category: string = "fact", importance: number = 3): UserMemory {
    const memory: UserMemory = {
      id: `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      user_id: userId,
      content,
      category,
      importance,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      source: "user_explicit",
    };

    const userMemories = this.memories.get(userId) || [];
    userMemories.push(memory);
    this.memories.set(userId, userMemories);

    return memory;
  }

  search(userId: string, query: string = "", category: string = "", maxResults: number = 10): UserMemory[] {
    let memories = this.memories.get(userId) || [];

    if (category) {
      memories = memories.filter((m) => m.category === category);
    }

    memories = [...memories].sort((a, b) => b.importance - a.importance);

    if (query) {
      const queryLower = query.toLowerCase();
      memories = memories.filter((m) => m.content.toLowerCase().includes(queryLower));
    }

    return memories.slice(0, maxResults);
  }

  delete(userId: string, memoryId: string): boolean {
    const memories = this.memories.get(userId) || [];
    const index = memories.findIndex((m) => m.id === memoryId);
    if (index === -1) return false;
    memories.splice(index, 1);
    return true;
  }
}

export const userMemoryStore = new UserMemoryStore();

// ============ Tool Descriptors ============

export const userMemorySearchDescriptor: ToolDescriptor = {
  name: "memory.user.search",
  version: "1.0.0",
  title: "用户记忆搜索",
  description:
    "搜索当前用户的长期记忆。当需要了解用户的偏好、习惯、个人信息等持久化记忆时使用。返回匹配的记忆条目。",
  category: "MEMORY",
  risk_level: "R1",
  side_effect: "read",
  timeout_ms: 5000,
  required_permissions: ["memory.user.read"],
  data_classification: ["pii"],
  owner: "memory",
  tags: ["memory", "user", "profile"],
  input_schema: {
    type: "object",
    properties: {
      user_id: { type: "string", description: "用户 ID" },
      query: { type: "string", description: "搜索关键词，留空则返回所有记忆" },
      category: { type: "string", description: "记忆类别过滤" },
      max_results: { type: "integer", description: "最多返回条数", default: 10 },
    },
    required: ["user_id"],
  },
};

export const userMemorySaveDescriptor: ToolDescriptor = {
  name: "memory.user.save",
  version: "1.0.0",
  title: "保存用户记忆",
  description:
    "保存一条关于用户的重要信息到长期记忆。只有用户明确表达或有长期价值的信息才应该保存。自动去重和合并相似记忆。",
  category: "MEMORY",
  risk_level: "R2",
  side_effect: "write",
  timeout_ms: 5000,
  required_permissions: ["memory.user.write"],
  data_classification: ["pii"],
  owner: "memory",
  tags: ["memory", "user", "profile"],
  input_schema: {
    type: "object",
    properties: {
      user_id: { type: "string", description: "用户 ID" },
      content: { type: "string", description: "要保存的记忆内容，简洁明确", maxLength: 200 },
      category: { type: "string", description: "记忆类别", default: "fact" },
      importance: { type: "integer", description: "重要性 1-5", default: 3, minimum: 1, maximum: 5 },
    },
    required: ["user_id", "content"],
  },
};

// ============ LangChain Tool: memory.user.search ============

export const memoryUserSearchTool: DynamicStructuredTool = new DynamicStructuredTool({
  name: "memory_user_search",
  description:
    "搜索当前用户的长期记忆。当需要了解用户的偏好、习惯、个人信息等持久化记忆时使用。",
  schema: z.object({
    user_id: z.string().describe("用户 ID"),
    query: z.string().default("").describe("搜索关键词，留空返回所有记忆"),
    category: z.string().default("").describe("记忆类别过滤"),
    max_results: z.number().int().min(1).max(50).default(10).describe("最多返回条数"),
  }),
  func: async ({ user_id, query, category, max_results }) => {
    const results = userMemoryStore.search(user_id, query || "", category || "", max_results || 10);

    if (results.length === 0) {
      return "🧠 未找到相关记忆。";
    }

    const lines: string[] = [`🧠 用户记忆（${user_id}）— ${results.length} 条：\n`];
    for (let i = 0; i < results.length; i++) {
      const m = results[i];
      lines.push(`[${i + 1}] [${m.category}] ${m.content}`);
      lines.push(`    重要性：${m.importance} | 来源：${m.source}`);
      lines.push("");
    }

    return lines.join("\n");
  },
});

// ============ LangChain Tool: memory.user.save ============

export const memoryUserSaveTool: DynamicStructuredTool = new DynamicStructuredTool({
  name: "memory_user_save",
  description:
    "保存一条关于用户的重要信息到长期记忆。只有用户明确表达或有长期价值的信息才应该保存。",
  schema: z.object({
    user_id: z.string().describe("用户 ID"),
    content: z.string().describe("要保存的记忆内容，简洁明确").max(200),
    category: z.string().default("fact").describe("记忆类别：preference / fact / decision / context"),
    importance: z.number().int().min(1).max(5).default(3).describe("重要性 1-5"),
  }),
  func: async ({ user_id, content, category, importance }) => {
    // 去重检查：用完整内容搜索所有记忆，精确匹配已存在的
    const existing = userMemoryStore.search(user_id, "", "", 100);
    const contentLower = content.toLowerCase().trim();
    for (const m of existing) {
      if (contentLower === m.content.toLowerCase().trim()) {
        return `🧠 记忆已存在（ID: ${m.id}），未重复保存。`;
      }
    }

    const memory = userMemoryStore.add(user_id, content, category || "fact", importance || 3);
    return `🧠 已保存记忆（ID: ${memory.id}）：${content}`;
  },
});
