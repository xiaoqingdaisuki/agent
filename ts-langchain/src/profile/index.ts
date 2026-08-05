import { randomUUID } from "crypto";

// ============ User Profile ==========

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

// ============ Memory ==========

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

// ============ Q&A History ==========

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

// 数据模型已迁移到 Cloudflare Service，本文件仅保留类型定义与工厂函数。
// ProfileStore 内存存储已移除。
