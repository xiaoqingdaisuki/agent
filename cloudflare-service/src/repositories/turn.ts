/** Agent Turn Repository — 单轮执行、幂等与恢复状态。 */

export type TurnStatus = "pending" | "streaming" | "completed" | "failed" | "cancelled";

export class TurnTransitionError extends Error {
  // 初始化非法 Turn 状态转换错误。
  constructor(public readonly current: TurnStatus, public readonly requested: TurnStatus) {
    super(`Cannot transition Turn from ${current} to ${requested}`);
    this.name = "TurnTransitionError";
  }
}

export class TurnConversationBusyError extends Error {
  // 初始化会话已有活动 Turn 的并发冲突错误。
  constructor(public readonly activeTurnId: string) {
    super("Conversation already has an active Turn");
    this.name = "TurnConversationBusyError";
  }
}

export interface Turn {
  id: string;
  conversation_id: string;
  user_id: string;
  client_message_id: string;
  status: TurnStatus;
  user_message_id: string | null;
  assistant_message_id: string | null;
  assistant_content_json: string | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface TurnCommandMessage {
  id: string;
  conversation_id: string;
  user_id: string;
  sequence_no: number;
  role: "user" | "assistant";
  content_json: string;
  created_at: string;
}

// 读取指定消息，供原子 Turn 命令返回实际分配的序号。
async function getCommandMessage(db: D1Database, messageId: string): Promise<TurnCommandMessage | null> {
  const result = await db.prepare(
    "SELECT id, conversation_id, user_id, sequence_no, role, content_json, created_at FROM messages WHERE id = ?",
  ).bind(messageId).first<TurnCommandMessage>();
  return result ?? null;
}

// 原子创建执行中 Turn 并追加用户消息，重复幂等键不会推进会话序号。
export async function beginTurnWithUserMessage(
  db: D1Database,
  input: Pick<Turn, "id" | "conversation_id" | "user_id" | "client_message_id"> & {
    user_message_id: string;
    user_content_json: string;
    created_at?: string;
  },
): Promise<{ turn: Turn; userMessage: TurnCommandMessage; created: boolean }> {
  const existing = await getTurnByClientMessageId(db, input.conversation_id, input.client_message_id);
  if (existing) {
    const existingMessage = existing.user_message_id
      ? await getCommandMessage(db, existing.user_message_id)
      : null;
    if (!existingMessage) throw new Error("Existing Turn is missing its user message");
    return { turn: existing, userMessage: existingMessage, created: false };
  }

  const now = input.created_at || new Date().toISOString();
  try {
    await db.batch([
      db.prepare(
        "INSERT INTO turns (id, conversation_id, user_id, client_message_id, status, user_message_id, created_at, updated_at) VALUES (?, ?, ?, ?, 'streaming', ?, ?, ?)",
      ).bind(input.id, input.conversation_id, input.user_id, input.client_message_id, input.user_message_id, now, now),
      db.prepare(
        `INSERT INTO messages (id, conversation_id, user_id, sequence_no, role, content_json, created_at)
         SELECT ?, c.id, c.user_id, c.next_sequence_no, 'user', ?, ?
         FROM conversations c JOIN turns t ON t.id = ?
         WHERE c.id = ? AND c.user_id = ? AND c.deleted_at IS NULL AND t.user_message_id = ?
         ON CONFLICT(id) DO NOTHING`,
      ).bind(input.user_message_id, input.user_content_json, now, input.id, input.conversation_id, input.user_id, input.user_message_id),
      db.prepare(
        `UPDATE conversations
         SET next_sequence_no = next_sequence_no + 1, message_count = message_count + 1,
             version = version + 1, updated_at = ?
         WHERE id = ? AND EXISTS (
           SELECT 1 FROM messages WHERE id = ? AND conversation_id = conversations.id
             AND sequence_no = conversations.next_sequence_no
         )`,
      ).bind(now, input.conversation_id, input.user_message_id),
    ]);
  } catch (error) {
    const raced = await getTurnByClientMessageId(db, input.conversation_id, input.client_message_id);
    if (raced?.user_message_id) {
      const racedMessage = await getCommandMessage(db, raced.user_message_id);
      if (racedMessage) return { turn: raced, userMessage: racedMessage, created: false };
    }
    const active = await db.prepare(
      "SELECT id FROM turns WHERE conversation_id = ? AND status IN ('pending', 'streaming') LIMIT 1",
    ).bind(input.conversation_id).first<{ id: string }>();
    if (active) throw new TurnConversationBusyError(active.id);
    throw error;
  }

  const turn = await getTurn(db, input.id);
  const userMessage = await getCommandMessage(db, input.user_message_id);
  if (!turn || !userMessage) throw new Error("Turn begin command did not persist atomically");
  return { turn, userMessage, created: true };
}

// 原子追加助手消息并完成 Turn，重复完成请求不会写入第二条消息。
export async function completeTurnWithAssistantMessage(
  db: D1Database,
  turnId: string,
  input: {
    user_id: string;
    assistant_message_id: string;
    assistant_content_json: string;
    message_content_json: string;
    created_at?: string;
  },
): Promise<{ turn: Turn; assistantMessage: TurnCommandMessage }> {
  const existing = await getTurn(db, turnId);
  if (!existing || existing.user_id !== input.user_id) throw new Error("Turn not found");
  if (existing.status === "completed" && existing.assistant_message_id) {
    const existingMessage = await getCommandMessage(db, existing.assistant_message_id);
    if (!existingMessage) throw new Error("Completed Turn is missing its assistant message");
    return { turn: existing, assistantMessage: existingMessage };
  }
  if (existing.status !== "streaming") {
    throw new TurnTransitionError(existing.status, "completed");
  }

  const now = input.created_at || new Date().toISOString();
  await db.batch([
    db.prepare(
      `INSERT INTO messages (id, conversation_id, user_id, sequence_no, role, content_json, created_at)
       SELECT ?, c.id, c.user_id, c.next_sequence_no, 'assistant', ?, ?
       FROM conversations c JOIN turns t ON t.conversation_id = c.id
       WHERE t.id = ? AND t.user_id = ? AND t.status = 'streaming' AND c.deleted_at IS NULL
       ON CONFLICT(id) DO NOTHING`,
    ).bind(input.assistant_message_id, input.message_content_json, now, turnId, input.user_id),
    db.prepare(
      `UPDATE conversations
       SET next_sequence_no = next_sequence_no + 1, message_count = message_count + 1,
           version = version + 1, updated_at = ?
       WHERE id = ? AND EXISTS (
         SELECT 1 FROM messages WHERE id = ? AND conversation_id = conversations.id
           AND sequence_no = conversations.next_sequence_no
       )`,
    ).bind(now, existing.conversation_id, input.assistant_message_id),
    db.prepare(
      `UPDATE turns SET status = 'completed', assistant_message_id = ?, assistant_content_json = ?,
       updated_at = ?, completed_at = ? WHERE id = ? AND user_id = ? AND status = 'streaming'`,
    ).bind(input.assistant_message_id, input.assistant_content_json, now, now, turnId, input.user_id),
  ]);

  const turn = await getTurn(db, turnId);
  const assistantMessage = await getCommandMessage(db, input.assistant_message_id);
  if (!turn || turn.status !== "completed" || !assistantMessage) {
    throw new Error("Turn complete command did not persist atomically");
  }
  return { turn, assistantMessage };
}

// 按会话和客户端消息 ID 读取唯一 Turn。
export async function getTurnByClientMessageId(
  db: D1Database,
  conversationId: string,
  clientMessageId: string,
): Promise<Turn | null> {
  const result = await db.prepare(
    "SELECT id, conversation_id, user_id, client_message_id, status, user_message_id, assistant_message_id, assistant_content_json, error_code, created_at, updated_at, completed_at FROM turns WHERE conversation_id = ? AND client_message_id = ?",
  ).bind(conversationId, clientMessageId).first<Turn>();
  return result ?? null;
}

// 读取指定 Turn，供状态轮询和恢复使用。
export async function getTurn(db: D1Database, turnId: string): Promise<Turn | null> {
  const result = await db.prepare(
    "SELECT id, conversation_id, user_id, client_message_id, status, user_message_id, assistant_message_id, assistant_content_json, error_code, created_at, updated_at, completed_at FROM turns WHERE id = ?",
  ).bind(turnId).first<Turn>();
  return result ?? null;
}

// 原子创建或复用同一客户端消息的 Turn，冲突时返回已有记录。
export async function createOrGetTurn(
  db: D1Database,
  input: Pick<Turn, "id" | "conversation_id" | "user_id" | "client_message_id">,
): Promise<{ turn: Turn; created: boolean }> {
  const existing = await getTurnByClientMessageId(db, input.conversation_id, input.client_message_id);
  if (existing) return { turn: existing, created: false };

  const now = new Date().toISOString();
  try {
    await db.prepare(
      "INSERT INTO turns (id, conversation_id, user_id, client_message_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)",
    ).bind(input.id, input.conversation_id, input.user_id, input.client_message_id, now, now).run();
  } catch (error) {
    const raced = await getTurnByClientMessageId(db, input.conversation_id, input.client_message_id);
    if (raced) return { turn: raced, created: false };
    const active = await db.prepare(
      "SELECT id FROM turns WHERE conversation_id = ? AND status IN ('pending', 'streaming') LIMIT 1",
    ).bind(input.conversation_id).first<{ id: string }>();
    if (active) throw new TurnConversationBusyError(active.id);
    throw error;
  }
  const turn = await getTurn(db, input.id);
  if (!turn) throw new Error("Turn creation did not persist");
  return { turn, created: true };
}

// 受限更新 Turn 状态及其最终结果，避免客户端改写身份和幂等键。
export async function updateTurn(
  db: D1Database,
  turnId: string,
  changes: Pick<Turn, "status"> & Partial<Pick<Turn, "user_message_id" | "assistant_message_id" | "assistant_content_json" | "error_code">>,
): Promise<Turn | null> {
  const existing = await getTurn(db, turnId);
  if (!existing) return null;
  if (existing.status === changes.status) return existing;
  const allowed: Record<TurnStatus, TurnStatus[]> = {
    pending: ["streaming", "failed", "cancelled"],
    streaming: ["completed", "failed", "cancelled"],
    completed: [],
    failed: [],
    cancelled: [],
  };
  if (!allowed[existing.status].includes(changes.status)) {
    throw new TurnTransitionError(existing.status, changes.status);
  }
  const now = new Date().toISOString();
  const terminal = ["completed", "failed", "cancelled"].includes(changes.status);
  await db.prepare(
    "UPDATE turns SET status = ?, user_message_id = COALESCE(?, user_message_id), assistant_message_id = COALESCE(?, assistant_message_id), assistant_content_json = COALESCE(?, assistant_content_json), error_code = COALESCE(?, error_code), updated_at = ?, completed_at = CASE WHEN ? THEN ? ELSE completed_at END WHERE id = ? AND status = ?",
  ).bind(changes.status, changes.user_message_id ?? null, changes.assistant_message_id ?? null, changes.assistant_content_json ?? null, changes.error_code ?? null, now, terminal ? 1 : 0, now, turnId, existing.status).run();
  const updated = await getTurn(db, turnId);
  if (updated && updated.status !== changes.status) {
    throw new TurnTransitionError(updated.status, changes.status);
  }
  return updated;
}

// 将超过恢复窗口的未完成 Turn 批量标记失败，避免服务重启后永久悬挂。
export async function failStaleTurns(
  db: D1Database,
  staleBefore: string,
): Promise<number> {
  const now = new Date().toISOString();
  const result = await db.prepare(
    "UPDATE turns SET status = 'failed', error_code = 'AGENT_RESTART_RECOVERY', updated_at = ?, completed_at = ? WHERE status IN ('pending', 'streaming') AND updated_at < ?",
  ).bind(now, now, staleBefore).run();
  return Number(result.meta?.changes ?? 0);
}
