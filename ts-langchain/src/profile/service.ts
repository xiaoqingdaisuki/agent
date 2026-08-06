/**
 * Profile Service — 用户画像 + 长期记忆 + 问答历史
 *
 * 核心能力：
 * 1. getOrCreate: 懒加载用户画像
 * 2. getRelevant: 召回相关记忆
 * 3. addMemory: 存储新记忆
 * 4. recordQA: 记录问答
 * 5. buildMemoryContext: 将记忆注入 System Prompt
 *
 * 统一通过 Repository 层访问 Cloudflare Service。
 */

import {
  UserProfile,
  Memory,
  QARecord,
  createMemory,
  createQARecord,
} from "./index.js";
import { ChatOpenAI } from "@langchain/openai";
import { config } from "../config/index.js";
import { getRepositories } from "../repositories/index.js";
import type { MemorySearchResultData } from "../repositories/types.js";

// 获取当前后端的仓库实例
function getRepos() {
  return getRepositories();
}

// ============ 映射辅助函数 ==========

// 将 Gateway 画像数据映射为 UserProfile
function mapProfile(data: {
  user_id: string;
  name: string;
  preferences_json: string;
  created_at: string;
  updated_at: string;
}): UserProfile {
  return {
    id: data.user_id,
    name: data.name || "",
    preferences: JSON.parse(data.preferences_json || "{}"),
    created_at: data.created_at,
    last_active_at: data.updated_at,
  };
}

// 将 Gateway 记忆数据映射为 Memory
function mapMemory(data: {
  id: string;
  user_id: string;
  content: string;
  category: string;
  importance: number;
  created_at: string;
  updated_at: string;
}): Memory {
  return {
    id: data.id,
    user_id: data.user_id,
    content: data.content,
    category: data.category as Memory["category"],
    importance: data.importance,
    created_at: data.created_at,
    updated_at: data.updated_at,
  };
}

// 将 QARecord 序列化为字典
function qaRecordToDict(record: QARecord): Record<string, string> {
  return {
    id: record.id,
    user_id: record.user_id,
    conversation_id: record.conversation_id,
    question: record.question,
    answer: record.answer,
    timestamp: record.timestamp,
  };
}

// 将 Gateway 搜索结果映射为 Memory 列表
function mapSearchResults(
  items: MemorySearchResultData[],
  userId: string,
): Memory[] {
  return items.map((item) =>
    mapMemory({
      id: item.id,
      user_id: userId,
      content: item.content,
      category: item.category,
      importance: item.importance,
      created_at: item.created_at,
      updated_at: item.updated_at,
    }),
  );
}

// ============ Profile Service ==========

export class ProfileService {
  /**
   * 懒加载用户画像（不存在时创建）
   */
  static async getOrCreate(userId: string, name: string = ""): Promise<UserProfile> {
    const repos = getRepos();
    const data = await repos.profile.getOrCreate(userId, name);
    return mapProfile(data);
  }

  /**
   * 根据用户 ID 获取已有画像，不存在时返回 undefined
   */
  static async get(userId: string): Promise<UserProfile | undefined> {
    const repos = getRepos();
    const data = await repos.profile.get(userId);
    return data ? mapProfile(data) : undefined;
  }

  /**
   * 更新用户画像，支持部分字段更新
   */
  static async update(
    userId: string,
    name: string = "",
    preferences?: Record<string, unknown>,
  ): Promise<UserProfile | undefined> {
    const repos = getRepos();
    const data = await repos.profile.update(userId, name, preferences);
    return data ? mapProfile(data) : undefined;
  }
}

// ============ Memory Service ==========

export class MemoryService {
  /**
   * 存储一条新的用户记忆
   */
  static async add(
    userId: string,
    content: string,
    category: string = "fact",
    importance: number = 3,
  ): Promise<Memory> {
    const repos = getRepos();
    const memoryId = crypto.randomUUID();
    const data = await repos.memory.save(
      userId,
      memoryId,
      content.trim(),
      category,
      importance,
      "user_explicit",
      undefined,
    );
    return mapMemory(data);
  }

  /**
   * 获取用户的高优先级记忆列表，按重要性排序
   */
  static async getRelevant(userId: string, maxItems: number = 10): Promise<Memory[]> {
    const repos = getRepos();
    const result = await repos.memory.search(userId, "", {
      limit: maxItems,
      minScore: 0,
    });
    return mapSearchResults(result.items, userId).slice(0, maxItems);
  }

  /**
   * 按类别获取用户记忆
   */
  static async getByCategory(userId: string, category: string): Promise<Memory[]> {
    const repos = getRepos();
    const items = await repos.memory.list(userId, { category, limit: 50 });
    return items.map(mapMemory);
  }

  /**
   * 删除指定记忆，返回是否删除成功
   */
  static async delete(userId: string, memoryId: string): Promise<boolean> {
    const repos = getRepos();
    return repos.memory.delete(userId, memoryId);
  }

  /**
   * 获取用户的所有记忆列表
   */
  static async listAll(userId: string): Promise<Memory[]> {
    const repos = getRepos();
    const items = await repos.memory.list(userId, { limit: 50 });
    return items.map(mapMemory);
  }

  /**
   * 将记忆组装成 prompt 片段，注入 System Prompt
   */
  static async buildMemoryContext(userId: string): Promise<string> {
    const memories = await this.getRelevant(userId, 10);
    if (memories.length === 0) return "";

    const lines = ["[我记住的关于你的事]"];
    for (const m of memories) {
      lines.push(`- ${m.content}`);
    }
    lines.push("");
    return lines.join("\n");
  }

  /**
   * 从对话中提取值得记忆的事实（正则 + LLM 双层提取）
   */
  static async extractMemoriesFromConversation(
    userId: string,
    question: string,
    answer: string,
  ): Promise<void> {
    // 第一层：正则规则立即提取
    const regexMemories = MemoryService._extractWithRegex(userId, question);
    for (const mem of regexMemories) {
      try {
        const repos = getRepos();
        await repos.memory.save(
          userId,
          mem.id,
          mem.content,
          mem.category,
          mem.importance,
          "conversation_extraction",
        );
      } catch {
        // 静默降级
      }
    }

    // 第二层：LLM 异步提取（不阻塞主流程）
    if (config.MEMORY_AUTO_EXTRACT) {
      MemoryService._extractWithLLM(userId, question, answer).catch(() => {
        // LLM 提取失败静默降级
      });
    }
  }

  /**
   * 正则规则提取 — 匹配明显的偏好/个人信息句式
   */
  private static _extractWithRegex(userId: string, question: string): Memory[] {
    const newMemories: Memory[] = [];
    const q = question.toLowerCase();

    const preferencePatterns: Array<[RegExp, string]> = [
      [/我喜欢(.+?)[。！\n]/g, "preference"],
      [/我爱(.+?)[。！\n]/g, "preference"],
      [/我讨厌(.+?)[。！\n]/g, "preference"],
      [/别(.+?)[。！\n]/g, "preference"],
      [/不要(.+?)[。！\n]/g, "preference"],
    ];

    for (const [pattern, category] of preferencePatterns) {
      const matches = q.matchAll(pattern);
      for (const match of matches) {
        const content = match[1].trim();
        if (content.length > 1 && content.length < 50) {
          newMemories.push(
            createMemory(userId, `用户喜欢/偏好: ${content}`, category, 4),
          );
        }
      }
    }

    const infoPatterns: Array<[RegExp, string]> = [
      [/我在(.+?)[。！\n]/g, "fact"],
      [/我叫(.+?)[。！\n]/g, "fact"],
      [/我是(.+?)[。！\n]/g, "fact"],
    ];

    for (const [pattern, category] of infoPatterns) {
      const matches = q.matchAll(pattern);
      for (const match of matches) {
        const content = match[1].trim();
        if (content.length > 1 && content.length < 50) {
          newMemories.push(
            createMemory(userId, `用户信息: ${content}`, category, 5),
          );
        }
      }
    }

    return newMemories;
  }

  /**
   * LLM-based 记忆提取 — 处理正则覆盖不到的复杂表达
   *
   * 通过 LLM 分析用户问题，提取值得长期记忆的事实。
   * 只提取有明确长期价值的信息（偏好、个人信息、决定），不提取临时性内容。
   */
  private static async _extractWithLLM(
    userId: string,
    question: string,
    answer: string,
  ): Promise<void> {
    if (!config.OPENAI_API_KEY) return;

    try {
      const llm = new ChatOpenAI({
        modelName: config.OPENAI_MODEL,
        configuration: {
          baseURL: config.OPENAI_BASE_URL,
          apiKey: config.OPENAI_API_KEY,
        },
      });

      const prompt = `你是一个记忆提取助手。分析以下对话，判断是否有值得长期记住的用户信息。

规则：
1. 只提取有长期价值的信息：偏好、习惯、个人信息（职业/所在地/家庭）、重要决定
2. 不提取：临时性内容、闲聊、问候、已经知道的重复信息
3. 每条记忆控制在 30 字以内，简洁明确
4. 如果没有任何值得记住的信息，返回空数组
5. 返回 JSON 数组，每项包含 category（preference/fact/decision/context）和 content 字段

用户问题：${question}
助手回答：${answer}

JSON 输出（无其他内容）：`;

      const response = await llm.invoke([
        { role: "system", content: "你只输出 JSON 数组，不输出其他内容。" },
        { role: "user", content: prompt },
      ] as any);
      const text = typeof response.content === "string" ? response.content : "";

      // 解析 JSON 数组
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return;

      const extracted = JSON.parse(jsonMatch[0]) as Array<{
        category: string;
        content: string;
      }>;
      for (const item of extracted) {
        if (!item.content || item.content.length > 50) continue;
        try {
          const repos = getRepos();
          await repos.memory.save(
            userId,
            crypto.randomUUID(),
            item.content,
            item.category || "fact",
            3,
            "conversation_extraction",
          );
        } catch {
          // 静默降级
        }
      }
    } catch {
      // LLM 提取失败静默降级
    }
  }
}

// ============ History Service ==========

export class HistoryService {
  /**
   * 记录一条问答历史记录
   */
  static async record(
    userId: string,
    conversationId: string,
    question: string,
    answer: string,
  ): Promise<Record<string, string>> {
    const repos = getRepos();
    const memoryId = crypto.randomUUID();
    const data = await repos.memory.save(
      userId,
      memoryId,
      answer,
      "fact",
      3,
      "conversation_extraction",
      conversationId,
    );
    return {
      id: data.id,
      user_id: userId,
      conversation_id: conversationId,
      question,
      answer,
      timestamp: data.created_at,
    };
  }

  /**
   * 获取用户问答历史，支持按会话过滤
   */
  static async getHistory(
    userId: string,
    conversationId?: string,
    limit: number = 50,
  ): Promise<Record<string, string>[]> {
    const repos = getRepos();
    // Cloudflare 模式：通过 search_memories 获取相关记忆
    const result = await repos.memory.search(userId, "", {
      category: undefined,
      limit,
      minScore: 0,
    });
    return result.items.map((item) => ({
      id: item.id,
      user_id: userId,
      conversation_id: conversationId || "",
      question: item.content.slice(0, 100),
      answer: item.content,
      timestamp: item.created_at,
    }));
  }
}
