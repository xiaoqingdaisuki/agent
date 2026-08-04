import { randomUUID } from "crypto";

// ============ User Profile ============

export interface UserProfile {
  id: string;
  name: string;
  preferences: Record<string, any>;
  created_at: string;
  last_active_at: string;
}

// 创建一个新的用户画像实例
export function createUserProfile(id: string, name: string = ""): UserProfile {
  const now = new Date().toISOString();
  return { id, name, preferences: {}, created_at: now, last_active_at: now };
}

// ============ Memory ============

export interface Memory {
  id: string;
  user_id: string;
  content: string;
  category: "preference" | "fact" | "decision" | "context";
  importance: number;
  created_at: string;
  updated_at: string;
}

// 创建一条新的记忆记录
export function createMemory(
  userId: string,
  content: string,
  category: string = "fact",
  importance: number = 3,
): Memory {
  const now = new Date().toISOString();
  return {
    id: `mem_${Date.now()}_${randomUUID().slice(0, 8)}`,
    user_id: userId,
    content: content.trim(),
    category: category as Memory["category"],
    importance,
    created_at: now,
    updated_at: now,
  };
}

// ============ Q&A History ============

export interface QARecord {
  id: string;
  user_id: string;
  conversation_id: string;
  question: string;
  answer: string;
  timestamp: string;
}

// 创建一条问答历史记录
export function createQARecord(
  userId: string,
  conversationId: string,
  question: string,
  answer: string,
): QARecord {
  return {
    id: `qa_${Date.now()}_${randomUUID().slice(0, 8)}`,
    user_id: userId,
    conversation_id: conversationId,
    question,
    answer,
    timestamp: new Date().toISOString(),
  };
}

// ============ In-Memory Store ============

class ProfileStore {
  private profiles = new Map<string, UserProfile>();
  private memories = new Map<string, Memory[]>();
  private qaRecords = new Map<string, QARecord[]>();

  // 根据用户 ID 获取用户画像
  getProfile(userId: string): UserProfile | undefined {
    return this.profiles.get(userId);
  }

  // 创建或覆盖用户画像
  createProfile(profile: UserProfile): UserProfile {
    this.profiles.set(profile.id, profile);
    return profile;
  }

  // 更新用户画像字段
  updateProfile(
    userId: string,
    updates: Partial<UserProfile>,
  ): UserProfile | undefined {
    const profile = this.profiles.get(userId);
    if (!profile) return undefined;
    Object.assign(profile, updates, {
      last_active_at: new Date().toISOString(),
    });
    return profile;
  }

  // 添加一条记忆
  addMemory(memory: Memory): Memory {
    const list = this.memories.get(memory.user_id) || [];
    list.push(memory);
    this.memories.set(memory.user_id, list);
    return memory;
  }

  // 获取用户的所有记忆，可按类别过滤
  getMemories(userId: string, category?: string): Memory[] {
    let memories = this.memories.get(userId) || [];
    if (category) {
      memories = memories.filter((m) => m.category === category);
    }
    return memories.sort((a, b) => b.importance - a.importance);
  }

  // 删除指定记忆，返回是否删除成功
  deleteMemory(userId: string, memoryId: string): boolean {
    const list = this.memories.get(userId) || [];
    const index = list.findIndex((m) => m.id === memoryId);
    if (index === -1) return false;
    list.splice(index, 1);
    return true;
  }

  // 添加一条问答记录
  addQARecord(record: QARecord): QARecord {
    const list = this.qaRecords.get(record.user_id) || [];
    list.push(record);
    this.qaRecords.set(record.user_id, list);
    return record;
  }

  // 获取用户问答历史，支持按会话过滤和数量限制
  getQAHistory(
    userId: string,
    conversationId?: string,
    limit = 50,
  ): QARecord[] {
    let records = this.qaRecords.get(userId) || [];
    if (conversationId) {
      records = records.filter((r) => r.conversation_id === conversationId);
    }
    return records.slice(-limit);
  }
}

export const profileStore = new ProfileStore();
