/**
 * memory.user — 用户长期记忆管理
 *
 * 提供用户记忆的搜索和保存能力。
 * 统一通过 Repository 层访问 Cloudflare Service。
 */

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";

import type { ToolDescriptor } from "./contracts.js";
import type { MemoryData } from "../repositories/types.js";
import { getRepositories } from "../repositories/index.js";
import { getToolCallContext } from "./runtime/executor.js";

// ============ Tool Descriptors ==========

export const memoryUserSearchInputSchema = z.object({
  user_id: z.string().describe("用户 ID"),
  query: z.string().default("").describe("搜索关键词，留空返回所有记忆"),
  category: z.string().default("").describe("记忆类别过滤"),
  max_results: z.number().int().min(1).max(50).default(10).describe("最多返回条数"),
});

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
  input_schema: memoryUserSearchInputSchema,
};

export const memoryUserSaveInputSchema = z.object({
  user_id: z.string().describe("用户 ID"),
  content: z.string().max(200).describe("要保存的记忆内容，简洁明确"),
  category: z.string().default("fact").describe("记忆类别"),
  importance: z.number().int().min(1).max(5).default(3).describe("重要性 1-5"),
});

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
  input_schema: memoryUserSaveInputSchema,
};

export const memoryUserListInputSchema = z.object({
  category: z.string().default("").describe("可选的记忆类别过滤"),
  max_results: z.number().int().min(1).max(100).default(50).describe("最多返回条数"),
});

export const userMemoryListDescriptor: ToolDescriptor = {
  name: "memory.user.list",
  version: "1.0.0",
  title: "查看用户记忆",
  description: "列出当前用户已保存的长期记忆，返回记忆 ID、内容和类别。",
  category: "MEMORY",
  risk_level: "R1",
  side_effect: "read",
  timeout_ms: 5000,
  required_permissions: ["memory.user.read"],
  data_classification: ["pii"],
  owner: "memory",
  tags: ["memory", "user", "list"],
  input_schema: memoryUserListInputSchema,
};

export const memoryUserDeleteInputSchema = z.object({
  memory_ids: z.array(z.string().min(1).max(128)).min(1).max(20).describe("要删除的精确记忆 ID 列表"),
});

export const userMemoryDeleteDescriptor: ToolDescriptor = {
  name: "memory.user.delete",
  version: "1.0.0",
  title: "删除用户记忆",
  description: "按精确 memory_id 删除当前用户的长期记忆。禁止根据模糊语义直接批量删除。",
  category: "MEMORY",
  risk_level: "R2",
  side_effect: "write",
  timeout_ms: 10000,
  required_permissions: ["memory.user.write"],
  data_classification: ["pii"],
  owner: "memory",
  tags: ["memory", "user", "delete"],
  input_schema: memoryUserDeleteInputSchema,
};

// ============ LangChain Tool: memory.user.search ==========

export const memoryUserSearchTool: DynamicStructuredTool =
  new DynamicStructuredTool({
    name: "memory_user_search",
    description:
      "搜索当前用户的长期记忆。当需要了解用户的偏好、习惯、个人信息等持久化记忆时使用。",
    schema: memoryUserSearchInputSchema,
    func: async ({ user_id, query, category, max_results }) => {
      const repos = getRepositories();

      try {
        if (category) {
          // 按类别精确查询
          const items = await repos.memory.list(user_id, {
            category,
            limit: max_results || 10,
          });
          const results = items.map((m: MemoryData) => ({
            id: m.id,
            content: m.content,
            category: m.category,
            importance: m.importance,
            created_at: m.created_at,
            updated_at: m.updated_at,
          }));

          if (results.length === 0) {
            return "🧠 该类别下未找到记忆。";
          }

          const lines: string[] = [
            `🧠 用户记忆（${user_id} / ${category}）— ${results.length} 条：\n`,
          ];
          for (let i = 0; i < results.length; i++) {
            const m = results[i];
            lines.push(`[${i + 1}] ${m.content}`);
            lines.push(`    重要性：${m.importance} | 创建：${m.created_at}`);
            lines.push("");
          }
          return lines.join("\n");
        }

        // 语义搜索
        const searchQuery = query || " ";
        const result = await repos.memory.search(user_id, searchQuery, {
          limit: max_results || 10,
          minScore: 0,
        });

        if (result.items.length === 0) {
          return "🧠 未找到相关记忆。";
        }

        const modeLabel = result.degraded ? "（降级模式）" : "";
        const lines: string[] = [
          `🧠 用户记忆（${user_id}）${modeLabel} — ${result.items.length} 条：\n`,
        ];
        for (let i = 0; i < result.items.length; i++) {
          const m = result.items[i];
          const score = result.degraded ? "" : ` | 相关度：${(m.semantic_score * 100).toFixed(0)}%`;
          lines.push(`[${i + 1}] [${m.category}] ${m.content}`);
          lines.push(`    重要性：${m.importance}${score}`);
          lines.push("");
        }

        return lines.join("\n");
      } catch {
        return "🧠 记忆搜索失败。";
      }
    },
  });

// ============ LangChain Tool: memory.user.save ==========

export const memoryUserSaveTool: DynamicStructuredTool =
  new DynamicStructuredTool({
    name: "memory_user_save",
    description:
      "保存一条关于用户的重要信息到长期记忆。只有用户明确表达或有长期价值的信息才应该保存。",
    schema: memoryUserSaveInputSchema,
    func: async ({ user_id, content, category, importance }) => {
      const repos = getRepositories();

      try {
        // Gateway 服务端去重
        const memoryId = crypto.randomUUID();
        const memory = await repos.memory.save(
          user_id,
          memoryId,
          content,
          category || "fact",
          importance || 3,
          "user_explicit",
        );
        return `🧠 已保存记忆（ID: ${memory.id}）：${content}`;
      } catch {
        return "🧠 记忆保存失败。";
      }
    },
  });

// 将长期记忆转换为面向对话的最小公开字段。
function toPublicMemory(memory: MemoryData): { memory_id: string; content: string; category: string } {
  return {
    memory_id: memory.id,
    content: memory.content,
    category: memory.category,
  };
}

// 列出当前可信用户的长期记忆。
export const memoryUserListTool: DynamicStructuredTool = new DynamicStructuredTool({
  name: "memory_user_list",
  description: "查看当前用户保存了哪些长期记忆。",
  schema: memoryUserListInputSchema,
  func: async ({ category, max_results }) => {
    const userId = getToolCallContext()?.user_id;
    if (!userId) return JSON.stringify({ memories: [], error: "缺少可信用户上下文" });
    try {
      const items = await getRepositories().memory.list(userId, {
        category: category || undefined,
        limit: max_results || 50,
      });
      return JSON.stringify({ memories: items.map(toPublicMemory) });
    } catch (error) {
      return JSON.stringify({ memories: [], error: `长期记忆读取失败：${error instanceof Error ? error.message : "未知错误"}` });
    }
  },
});

// 按精确 ID 删除当前可信用户的长期记忆。
export const memoryUserDeleteTool: DynamicStructuredTool = new DynamicStructuredTool({
  name: "memory_user_delete",
  description: "按精确 memory_id 删除当前用户的长期记忆；不能根据模糊语义猜测要删除的记忆。",
  schema: memoryUserDeleteInputSchema,
  func: async ({ memory_ids }) => {
    const userId = getToolCallContext()?.user_id;
    if (!userId) return JSON.stringify({ deleted: [], error: "缺少可信用户上下文" });
    if (new Set(memory_ids).size !== memory_ids.length) {
      return JSON.stringify({ deleted: [], error: "memory_ids 不能重复" });
    }
    try {
      const deleted: string[] = [];
      for (const memoryId of memory_ids) {
        if (await getRepositories().memory.delete(userId, memoryId)) deleted.push(memoryId);
      }
      return JSON.stringify({ deleted });
    } catch (error) {
      return JSON.stringify({ deleted: [], error: `长期记忆删除失败：${error instanceof Error ? error.message : "未知错误"}` });
    }
  },
});
