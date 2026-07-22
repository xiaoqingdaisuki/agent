import { ChatOpenAI } from "@langchain/openai";
import { AIMessage, BaseMessage, HumanMessage } from "@langchain/core/messages";
import { SYSTEM_PROMPT } from "../prompts/system.js";
import { appendMessage, getHistory } from "../memory/conversation.js";

let chatAgent: ChatOpenAI | null = null;

function toOpenAIMessage(message: BaseMessage) {
  const type = message._getType();
  const role = type === "human" ? "user" : type === "system" ? "system" : "assistant";
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

export async function chat(agent: ChatOpenAI, message: string, threadId: string) {
  const response = await agent.invoke([
    { role: "system", content: SYSTEM_PROMPT },
    ...getHistory(threadId).map(toOpenAIMessage),
    { role: "user", content: message },
  ]);
  const reply = typeof response.content === "string" ? response.content : response.text;

  appendMessage(threadId, new HumanMessage(message));
  appendMessage(threadId, new AIMessage(reply));

  return { reply, threadId };
}
