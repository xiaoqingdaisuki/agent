/**
 * Conversation Memory — 对话历史管理
 *
 * 维护 Agent 运行时上下文窗口；业务消息持久化统一由 ConversationService 负责，避免重复写入。
 *
 * 流式响应只在实际成功时落库，防止重复消息。
 */

import { BaseMessage, HumanMessage, AIMessage, SystemMessage } from "@langchain/core/messages";
import { getRepositories } from "../repositories/index.js";
import { config } from "../config/index.js";

export const MAX_HISTORY_TOKENS = config.HISTORY_CONTEXT_TOKEN_BUDGET;
const HISTORY_LOAD_PAGE_SIZE = 200;

// 进程内对话历史（仅当前运行上下文使用）
const conversations = new Map<string, BaseMessage[]>();

// 将多种 LangChain 消息内容归一化为可估算 token 的文本。
function messageContentToText(content: BaseMessage["content"]): string {
  return typeof content === "string" ? content : JSON.stringify(content);
}

// 估算中英文混合内容的 token 数，用于没有模型专用 tokenizer 时的保守预算控制。
export function estimateMessageTokens(message: BaseMessage): number {
  const text = messageContentToText(message.content);
  const cjkCharacters = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
  return Math.max(1, cjkCharacters + Math.ceil((text.length - cjkCharacters) / 4) + 4);
}

// 以完整用户轮次为原子单位保留最新历史，绝不拆开 assistant 工具调用及其结果。
export function trimHistoryToTokenBudget(
  messages: BaseMessage[],
  tokenBudget = MAX_HISTORY_TOKENS,
): BaseMessage[] {
  const turnStarts = messages
    .map((message, index) => (message._getType() === "human" ? index : -1))
    .filter((index) => index >= 0);
  if (turnStarts.length === 0) return [...messages];

  let keepFrom = messages.length;
  let usedTokens = 0;
  for (let turn = turnStarts.length - 1; turn >= 0; turn -= 1) {
    const start = turnStarts[turn];
    const end = turn + 1 < turnStarts.length ? turnStarts[turn + 1] : messages.length;
    const turnTokens = messages.slice(start, end).reduce((total, message) => total + estimateMessageTokens(message), 0);
    if (keepFrom !== messages.length && usedTokens + turnTokens > tokenBudget) break;
    usedTokens += turnTokens;
    keepFrom = start;
  }
  return messages.slice(keepFrom);
}

/**
 * 获取指定线程的对话历史，内存未命中时从 D1 加载
 */
// 获取 getHistory 对应的数据
export async function getHistory(threadId: string): Promise<BaseMessage[]> {
  const cached = conversations.get(threadId);

  // 每次从仓储刷新，确保多请求实例和上一轮异步持久化的消息都能被读取。
  try {
    const repos = getRepositories();
    // 倒序只读取最近一页，随后恢复正序；token 裁剪会移除开头的不完整轮次。
    const page = await repos.message.getMessages(
      threadId,
      HISTORY_LOAD_PAGE_SIZE,
      0,
      "desc",
    );
    const messages = [...page.messages].reverse();
    if (messages.length === 0 && cached && cached.length > 0) return [...cached];
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
    const bounded = trimHistoryToTokenBudget(loaded);
    conversations.set(threadId, bounded);
    return [...bounded];
  } catch (err) {
    console.warn(`[memory] D1 load messages failed for thread ${threadId}: ${err}`);
    return cached ? [...cached] : [];
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
  const history = conversations.get(threadId) ?? (await getHistory(threadId));
  history.push(message);

  const bounded = trimHistoryToTokenBudget(history);
  history.splice(0, history.length, ...bounded);
}

/**
 * 清空指定线程的 Agent 运行时对话历史
 */
// 删除或清理 clearHistory 对应的数据
export async function clearHistory(threadId: string): Promise<void> {
  conversations.delete(threadId);
}
