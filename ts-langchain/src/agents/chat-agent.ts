import { ChatOpenAI } from "@langchain/openai";
import { AIMessage, BaseMessage, HumanMessage } from "@langchain/core/messages";
import { SYSTEM_PROMPT } from "../prompts/system.js";
import { ProfileService, MemoryService } from "../profile/service.js";
import { appendMessage, getHistory } from "../memory/conversation.js";

let chatAgent: ChatOpenAI | null = null;

// 将 LangChain BaseMessage 转换为 OpenAI API 消息格式
function toOpenAIMessage(message: BaseMessage) {
  const type = message._getType();
  const role =
    type === "human" ? "user" : type === "system" ? "system" : "assistant";
  return { role, content: message.content };
}

export function createChatAgent(): ChatOpenAI {
  if (chatAgent) return chatAgent;

  chatAgent = new ChatOpenAI({
    modelName: process.env.OPENAI_MODEL || "step-3.7-flash",
    configuration: {
      baseURL: process.env.OPENAI_BASE_URL,
      apiKey: process.env.OPENAI_API_KEY,
    },
  });

  return chatAgent;
}

export async function chat(
  agent: ChatOpenAI,
  message: string,
  threadId: string,
  userId?: string,
) {
  let systemPrompt = SYSTEM_PROMPT;

  // 注入用户记忆
  if (userId) {
    try {
      const profile = await ProfileService.getOrCreate(userId);
      const memoryContextStr = await MemoryService.buildMemoryContext(userId);
      if (memoryContextStr) {
        systemPrompt = `${memoryContextStr}\n\n${SYSTEM_PROMPT}`;
      }
    } catch {
      // 记忆模块不可用时静默降级
    }
  }

  const response = await agent.invoke([
    { role: "system", content: systemPrompt },
    ...getHistory(threadId).map(toOpenAIMessage),
    { role: "user", content: message },
  ]);
  const reply =
    typeof response.content === "string" ? response.content : response.text;

  appendMessage(threadId, new HumanMessage(message));
  appendMessage(threadId, new AIMessage(reply));

  return { reply, threadId };
}
