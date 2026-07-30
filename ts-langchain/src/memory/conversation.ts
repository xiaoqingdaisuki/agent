import { BaseMessage } from "@langchain/core/messages";
import { sessionStore } from "../tools/memory-session.js";

const conversations = new Map<string, BaseMessage[]>();
export const MAX_HISTORY_MESSAGES = 50;

export function getHistory(threadId: string): BaseMessage[] {
  if (!conversations.has(threadId)) {
    conversations.set(threadId, []);
  }
  return conversations.get(threadId)!;
}

export function appendMessage(threadId: string, message: BaseMessage): void {
  const history = getHistory(threadId);
  history.push(message);
  const role = message._getType() === "human" ? "user" : "assistant";
  const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
  sessionStore.add(threadId, role, content);
  if (history.length > MAX_HISTORY_MESSAGES) {
    let keepFrom = history.length - MAX_HISTORY_MESSAGES;
    while (keepFrom < history.length && history[keepFrom]._getType() !== "human") {
      keepFrom++;
    }
    history.splice(0, keepFrom);
  }
}

export function clearHistory(threadId: string): void {
  conversations.delete(threadId);
  sessionStore.clear(threadId);
}
