/**
 * Conversation Memory — 对话历史管理
 *
 * 维护 Agent 运行时上下文窗口；业务消息持久化统一由 ConversationService 负责，避免重复写入。
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
// 获取 getHistory 对应的数据
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

// 返回不含当前重复用户输入的历史，避免同时作为 input 与 chat_history 发送
export async function getHistoryBeforeInput(
  threadId: string,
  currentInput: string,
): Promise<BaseMessage[]> {
  const history = [...(await getHistory(threadId))];
  const last = history.at(-1);
  if (last?._getType() === "human" && last.content === currentInput) {
    history.pop();
  }
  return history;
}

/**
 * 向指定线程追加一条消息，超出上限时裁剪旧消息
 *
 */
// 创建或注册 appendMessage 所需的数据
export async function appendMessage(threadId: string, message: BaseMessage): Promise<void> {
  const history = await getHistory(threadId);
  history.push(message);

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
 * 清空指定线程的 Agent 运行时对话历史
 */
// 删除或清理 clearHistory 对应的数据
export async function clearHistory(threadId: string): Promise<void> {
  conversations.delete(threadId);
}
