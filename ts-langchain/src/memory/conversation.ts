/**
 * Conversation Memory — 对话历史管理
 *
 * 维护两层存储：
 * 1. 进程内 Map：当前 Agent 运行的上下文窗口（BaseMessage[]）
 * 2. Repository：跨进程/跨会话持久化（通过 Gateway 或内存）
 *
 * 流式响应只在实际成功时落库，防止重复消息。
 */

import { BaseMessage, HumanMessage, AIMessage, SystemMessage } from "@langchain/core/messages";
import { getRepositories } from "../repositories/index.js";

export const MAX_HISTORY_MESSAGES = 50;

// 进程内对话历史（仅当前运行上下文使用）
const conversations = new Map<string, BaseMessage[]>();

/**
 * 获取指定线程的对话历史，内存未命中时从 D1 加载
 */
export async function getHistory(threadId: string): Promise<BaseMessage[]> {
  const cached = conversations.get(threadId);
  if (cached && cached.length > 0) return cached;

  // D1 回退
  try {
    const repos = getRepositories();
    const { messages } = await repos.message.getMessages(threadId, MAX_HISTORY_MESSAGES, 0);
    const loaded: BaseMessage[] = [];
    for (const m of messages) {
      const content = m.content_json;
      if (m.role === "user") {
        loaded.push(new HumanMessage(content));
      } else if (m.role === "assistant") {
        loaded.push(new AIMessage(content));
      } else if (m.role === "system") {
        loaded.push(new SystemMessage(content));
      }
    }
    conversations.set(threadId, loaded);
    return loaded;
  } catch (err) {
    console.warn(`[memory] D1 load messages failed for thread ${threadId}: ${err}`);
    return conversations.get(threadId) ?? [];
  }
}

/**
 * 向指定线程追加一条消息，超出上限时裁剪旧消息
 *
 * 同时持久化到 Repository（异步，不阻塞主流程）。
 */
export async function appendMessage(threadId: string, message: BaseMessage): Promise<void> {
  const history = await getHistory(threadId);
  history.push(message);

  const role = message._getType() === "human" ? "user" : "assistant";
  const content =
    typeof message.content === "string"
      ? message.content
      : JSON.stringify(message.content);

  // 异步持久化到 Repository
  try {
    const repos = getRepositories();
    // 确保存在一个会话（使用 threadId 作为 conversation_id）
    // 注意：这里简化处理，实际应用中 conversation 应在 API 层创建
    await repos.message.createBatch(threadId, "", [
      {
        id: crypto.randomUUID(),
        conversation_id: threadId,
        user_id: "",
        sequence_no: history.length - 1,
        role: role as "user" | "assistant",
        content_json: content,
        created_at: new Date().toISOString(),
      },
    ]);
  } catch (err) {
    console.error(`[memory] Failed to persist message to D1 for thread ${threadId}: ${err}`);
  }

  // 裁剪超出上限的旧消息
  if (history.length > MAX_HISTORY_MESSAGES) {
    let keepFrom = history.length - MAX_HISTORY_MESSAGES;
    while (
      keepFrom < history.length &&
      history[keepFrom]._getType() !== "human"
    ) {
      keepFrom++;
    }
    history.splice(0, keepFrom);
  }
}

/**
 * 清空指定线程的全部对话历史和会话存储
 */
export async function clearHistory(threadId: string): Promise<void> {
  conversations.delete(threadId);

  // 异步清空 Repository 中的消息
  try {
    const repos = getRepositories();
    await repos.message.clear(threadId);
  } catch (err) {
    console.warn(`[memory] D1 clear messages failed for thread ${threadId}: ${err}`);
  }
}
