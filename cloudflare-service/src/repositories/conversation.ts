/**
 * ConversationRepository — 会话仓储
 *
 * 直接操作 D1，提供会话的 CRUD 操作
 */

// 会话数据类型
export interface Conversation {
  id: string;
  user_id: string;
  title: string;
  mode: "chat" | "knowledge" | "mixed";
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

// 创建会话
export async function createConversation(db: D1Database, conv: Omit<Conversation, "created_at" | "updated_at" | "deleted_at">): Promise<Conversation> {
  const now = new Date().toISOString();
  await db
    .prepare("INSERT INTO conversations (id, user_id, title, mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(conv.id, conv.user_id, conv.title, conv.mode, now, now)
    .run();

  return { ...conv, created_at: now, updated_at: now, deleted_at: null };
}

// 获取会话
export async function getConversation(db: D1Database, id: string): Promise<Conversation | null> {
  const result = await db
    .prepare("SELECT id, user_id, title, mode, created_at, updated_at, deleted_at FROM conversations WHERE id = ?")
    .bind(id)
    .first<Conversation>();

  return result ?? null;
}

// 列出用户的会话（分页）
export async function listConversationsByUser(db: D1Database, userId: string, limit = 20, offset = 0): Promise<Conversation[]> {
  const { results } = await db
    .prepare("SELECT id, user_id, title, mode, created_at, updated_at, deleted_at FROM conversations WHERE user_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT ? OFFSET ?")
    .bind(userId, limit, offset)
    .all<Conversation>();

  return results ?? [];
}

// 软删除会话
export async function deleteConversation(db: D1Database, id: string): Promise<boolean> {
  const now = new Date().toISOString();
  const result = await db
    .prepare("UPDATE conversations SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL")
    .bind(now, id)
    .run();

  return (result.meta?.rows_written ?? 0) > 0;
}
