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

// 获取会话下一条可用消息序号
export async function getNextSequenceNumber(db: D1Database, conversationId: string): Promise<number> {
  const result = await db
    .prepare("SELECT COALESCE(MAX(sequence_no), -1) + 1 AS next_sequence FROM messages WHERE conversation_id = ?")
    .bind(conversationId)
    .first<{ next_sequence: number }>();
  return result?.next_sequence ?? 0;
}

// 批量写入消息（一个完整 turn）
export async function createMessageBatch(db: D1Database, messages: Message[]): Promise<void> {
  if (messages.length === 0) return;

  // 验证 sequence_no 连续性
  messages.sort((a, b) => a.sequence_no - b.sequence_no);

  const stmt = db.prepare(
    `INSERT INTO messages (id, conversation_id, user_id, sequence_no, role, content_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET role = excluded.role, content_json = excluded.content_json`,
  );

  const conversationId = messages[0].conversation_id;
  const maxSequence = Math.max(...messages.map((message) => message.sequence_no));
  await db.batch([
    ...messages.map((msg) =>
      stmt.bind(
        msg.id,
        msg.conversation_id,
        msg.user_id,
        msg.sequence_no,
        msg.role,
        msg.content_json,
        msg.created_at,
      ),
    ),
    db.prepare(
      `UPDATE conversations SET
       next_sequence_no = MAX(next_sequence_no, ?),
       message_count = (SELECT COUNT(*) FROM messages WHERE conversation_id = ?),
       version = version + 1, updated_at = ? WHERE id = ?`,
    ).bind(maxSequence + 1, conversationId, new Date().toISOString(), conversationId),
  ]);
}

// 使用会话计数器为无显式序号的消息批次原子分配连续序号。
export async function createMessageBatchWithCounter(
  db: D1Database,
  conversationId: string,
  userId: string,
  messages: Array<Omit<Message, "conversation_id" | "user_id" | "sequence_no">>,
): Promise<void> {
  if (messages.length === 0) return;
  const statements: D1PreparedStatement[] = [];
  for (const message of messages) {
    statements.push(
      db.prepare(
        `INSERT INTO messages (id, conversation_id, user_id, sequence_no, role, content_json, created_at)
         SELECT ?, id, user_id, next_sequence_no, ?, ?, ? FROM conversations
         WHERE id = ? AND user_id = ? AND deleted_at IS NULL
         ON CONFLICT(id) DO UPDATE SET role = excluded.role, content_json = excluded.content_json`,
      ).bind(message.id, message.role, message.content_json, message.created_at, conversationId, userId),
      db.prepare(
        `UPDATE conversations SET next_sequence_no = next_sequence_no + 1,
         message_count = message_count + 1, version = version + 1, updated_at = ?
         WHERE id = ? AND EXISTS (
           SELECT 1 FROM messages WHERE id = ? AND conversation_id = conversations.id
             AND sequence_no = conversations.next_sequence_no
         )`,
      ).bind(new Date().toISOString(), conversationId, message.id),
    );
  }
  await db.batch(statements);
}

// 获取会话消息列表
export async function getMessagesByConversation(
  db: D1Database,
  conversationId: string,
  limit = 50,
  offset = 0,
  direction: "asc" | "desc" = "asc",
): Promise<{ messages: Message[]; total: number }> {
  const order = direction === "desc" ? "DESC" : "ASC";
  const { results } = await db
    .prepare(`SELECT id, conversation_id, user_id, sequence_no, role, content_json, created_at FROM messages WHERE conversation_id = ? ORDER BY sequence_no ${order} LIMIT ? OFFSET ?`)
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
  const now = new Date().toISOString();
  await db.batch([
    db.prepare("DELETE FROM messages WHERE conversation_id = ?").bind(conversationId),
    db.prepare("UPDATE conversations SET next_sequence_no = 0, message_count = 0, version = version + 1, updated_at = ? WHERE id = ?").bind(now, conversationId),
  ]);
}
