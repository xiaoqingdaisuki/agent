/**
 * Profile Service — 用户画像 + 长期记忆 + 问答历史
 *
 * 核心能力：
 * 1. getOrCreate: 懒加载用户画像
 * 2. getRelevantMemories: 召回相关记忆
 * 3. addMemory: 存储新记忆
 * 4. recordQA: 记录问答
 * 5. buildMemoryContext: 将记忆注入 System Prompt
 */

import {
  profileStore,
  UserProfile,
  Memory,
  QARecord,
  createMemory,
  createQARecord,
} from "./index.js";
import { ChatOpenAI } from "@langchain/openai";
import { config } from "../config/index.js";

// ============ Profile Service ============

export class ProfileService {
  static getOrCreate(userId: string, name: string = ""): UserProfile {
    let profile = profileStore.getProfile(userId);
    if (!profile) {
      profile = { id: userId, name, preferences: {}, created_at: new Date().toISOString(), last_active_at: new Date().toISOString() };
      profileStore.createProfile(profile);
    } else {
      profileStore.updateProfile(userId, {}); // update last_active_at
    }
    return profile;
  }

  // 根据用户 ID 获取已有画像，不存在时返回 undefined
  static get(userId: string): UserProfile | undefined {
    return profileStore.getProfile(userId);
  }

  // 更新用户画像，支持部分字段更新
  static update(userId: string, updates?: Partial<UserProfile>): UserProfile | undefined {
    return profileStore.updateProfile(userId, updates ?? {});
  }
}

// ============ Memory Service ============

export class MemoryService {
  // 存储一条新的用户记忆
  static add(userId: string, content: string, category: string = "fact", importance: number = 3): Memory {
    const memory = createMemory(userId, content, category, importance);
    return profileStore.addMemory(memory);
  }

  // 获取用户的高优先级记忆列表，按重要性排序
  static getRelevant(userId: string, maxItems: number = 10): Memory[] {
    const memories = profileStore.getMemories(userId);
    return memories.slice(0, maxItems);
  }

  // 按类别获取用户记忆
  static getByCategory(userId: string, category: string): Memory[] {
    return profileStore.getMemories(userId, category);
  }

  // 删除指定记忆，返回是否删除成功
  static delete(userId: string, memoryId: string): boolean {
    return profileStore.deleteMemory(userId, memoryId);
  }

  // 获取用户的所有记忆列表
  static listAll(userId: string): Memory[] {
    return profileStore.getMemories(userId);
  }

  // 将记忆组装成 prompt 片段，注入 System Prompt
  static buildMemoryContext(userId: string): string {
    const memories = profileStore.getMemories(userId).slice(0, 10);
    if (memories.length === 0) return "";

    const lines = ["[我记住的关于你的事]"];
    for (const m of memories) {
      lines.push(`- ${m.content}`);
    }
    lines.push("");
    return lines.join("\n");
  }

  static extractMemoriesFromConversation(userId: string, question: string, answer: string): Memory[] {
    // 同步调用正则提取（立即返回），LLM 提取在后台异步执行
    const regexMemories = MemoryService._extractWithRegex(userId, question);
    for (const mem of regexMemories) {
      profileStore.addMemory(mem);
    }

    // 异步 LLM 提取（不阻塞主流程）
    MemoryService._extractWithLLM(userId, question, answer).catch(() => {
      // LLM 提取失败不影响主流程
    });

    return regexMemories;
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
          newMemories.push(createMemory(userId, `用户喜欢/偏好: ${content}`, category, 4));
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
          newMemories.push(createMemory(userId, `用户信息: ${content}`, category, 5));
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
  private static async _extractWithLLM(userId: string, question: string, answer: string): Promise<void> {
    if (!config.OPENAI_API_KEY) return;

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

    try {
      const response = await llm.invoke([
        { role: "system", content: "你只输出 JSON 数组，不输出其他内容。" },
        { role: "user", content: prompt },
      ] as any);
      const text = typeof response.content === "string" ? response.content : "";

      // 解析 JSON 数组
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return;

      const extracted = JSON.parse(jsonMatch[0]) as Array<{ category: string; content: string }>;
      for (const item of extracted) {
        if (!item.content || item.content.length > 50) continue;
        const memory = createMemory(userId, item.content, item.category || "fact", 3);
        profileStore.addMemory(memory);
      }
    } catch {
      // LLM 提取失败静默降级
    }
  }
}

// ============ History Service ============

export class HistoryService {
  // 记录一条问答历史记录
  static record(userId: string, conversationId: string, question: string, answer: string): QARecord {
    const record = createQARecord(userId, conversationId, question, answer);
    return profileStore.addQARecord(record);
  }

  // 获取用户问答历史，支持按会话过滤
  static getHistory(userId: string, conversationId?: string, limit: number = 50): QARecord[] {
    return profileStore.getQAHistory(userId, conversationId, limit);
  }
}
