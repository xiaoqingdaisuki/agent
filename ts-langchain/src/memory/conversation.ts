import { BaseMessage } from "@langchain/core/messages";

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
}
