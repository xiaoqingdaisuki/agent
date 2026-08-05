/**
 * Conversation Memory — 对话历史管理
 *
 * 维护两层存储：
 * 1. 进程内 Map：当前 Agent 运行的上下文窗口（BaseMessage[]）
 * 2. Repository：跨进程/跨会话持久化（通过 Gateway 或内存）
 *
 * 流式响应只在实际成功时落库，防止重复消息。
 */

import { BaseMessage } from "@langchain/core/messages";
import { getRepositories } from "../repositories/index.js";

export const MAX_HISTORY_MESSAGES = 50;

// 进程内对话历史（仅当前运行上下文使用）
const conversations = new Map<string, BaseMessage[]>();

/**
 * 获取指定线程的对话历史，不存在则返回空数组
 */
export function getHistory(threadId: string): BaseMessage[] {
  if (!conversations.has(threadId)) {
    conversations.set(threadId, []);
  }
  return conversations.get(threadId)!;
}

/**
 * 向指定线程追加一条消息，超出上限时裁剪旧消息
 *
 * 同时持久化到 Repository（异步，不阻塞主流程）。
 */
export async function appendMessage(threadId: string, message: BaseMessage): Promise<void> {
  const history = getHistory(threadId);
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
  } catch {
    // 持久化失败不影响进程内历史
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
  } catch {
    // 清空失败不影响进程内清理
  }
}
