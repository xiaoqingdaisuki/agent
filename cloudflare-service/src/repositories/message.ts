/**
 * MessageRepository — 消息仓储
 *
 * 直接操作 D1，提供消息的批量写入和查询
 */

// 消息数据类型
export interface Message {
  id: string;
  conversation_id: string;
  user_id: string;
  sequence_no: number;
  role: "user" | "assistant" | "system" | "tool";
  content_json: string;
  created_at: string;
}

// 批量写入消息（一个完整 turn）
export async function createMessageBatch(db: D1Database, messages: Message[]): Promise<void> {
  if (messages.length === 0) return;

  // 验证 sequence_no 连续性
  messages.sort((a, b) => a.sequence_no - b.sequence_no);

  const stmt = db.prepare(
    "INSERT OR REPLACE INTO messages (id, conversation_id, user_id, sequence_no, role, content_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );

  for (const msg of messages) {
    await stmt.bind(msg.id, msg.conversation_id, msg.user_id, msg.sequence_no, msg.role, msg.content_json, msg.created_at).run();
  }
}

// 获取会话消息列表
export async function getMessagesByConversation(db: D1Database, conversationId: string, limit = 50, offset = 0): Promise<{ messages: Message[]; total: number }> {
  const { results } = await db
    .prepare("SELECT id, conversation_id, user_id, sequence_no, role, content_json, created_at FROM messages WHERE conversation_id = ? ORDER BY sequence_no LIMIT ? OFFSET ?")
    .bind(conversationId, limit, offset)
    .all<Message>();

  const countResult = await db
    .prepare("SELECT COUNT(*) as cnt FROM messages WHERE conversation_id = ?")
    .bind(conversationId)
    .first<{ cnt: number }>();

  return {
    messages: results ?? [],
    total: countResult?.cnt ?? 0,
  };
}

// 清空会话消息
export async function clearMessages(db: D1Database, conversationId: string): Promise<void> {
  await db.prepare("DELETE FROM messages WHERE conversation_id = ?").bind(conversationId).run();
}
