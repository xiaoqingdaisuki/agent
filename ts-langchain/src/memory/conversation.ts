import { BaseMessage } from "@langchain/core/messages";

const conversations = new Map<string, BaseMessage[]>();

export function getHistory(threadId: string): BaseMessage[] {
  if (!conversations.has(threadId)) {
    conversations.set(threadId, []);
  }
  return conversations.get(threadId)!;
}

export function appendMessage(threadId: string, message: BaseMessage): void {
  const history = getHistory(threadId);
  history.push(message);
}

export function clearHistory(threadId: string): void {
  conversations.delete(threadId);
}
