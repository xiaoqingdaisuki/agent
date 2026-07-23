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

  static get(userId: string): UserProfile | undefined {
    return profileStore.getProfile(userId);
  }

  static update(userId: string, updates?: Partial<UserProfile>): UserProfile | undefined {
    return profileStore.updateProfile(userId, updates ?? {});
  }
}

// ============ Memory Service ============

export class MemoryService {
  static add(userId: string, content: string, category: string = "fact", importance: number = 3): Memory {
    const memory = createMemory(userId, content, category, importance);
    return profileStore.addMemory(memory);
  }

  static getRelevant(userId: string, maxItems: number = 10): Memory[] {
    const memories = profileStore.getMemories(userId);
    return memories.slice(0, maxItems);
  }

  static getByCategory(userId: string, category: string): Memory[] {
    return profileStore.getMemories(userId, category);
  }

  static delete(userId: string, memoryId: string): boolean {
    return profileStore.deleteMemory(userId, memoryId);
  }

  static listAll(userId: string): Memory[] {
    return profileStore.getMemories(userId);
  }

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

  static extractMemoriesFromConversation(userId: string, question: string, _answer: string): Memory[] {
    const newMemories: Memory[] = [];
    const q = question.toLowerCase();

    // 偏好提取规则（matchAll 需要 /g flag）
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

    // 个人信息提取规则（matchAll 需要 /g flag）
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

    for (const mem of newMemories) {
      profileStore.addMemory(mem);
    }

    return newMemories;
  }
}

// ============ History Service ============

export class HistoryService {
  static record(userId: string, conversationId: string, question: string, answer: string): QARecord {
    const record = createQARecord(userId, conversationId, question, answer);
    return profileStore.addQARecord(record);
  }

  static getHistory(userId: string, conversationId?: string, limit: number = 50): QARecord[] {
    return profileStore.getQAHistory(userId, conversationId, limit);
  }
}
