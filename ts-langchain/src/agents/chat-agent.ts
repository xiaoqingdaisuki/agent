import { ChatOpenAI } from "@langchain/openai";
import { createOpenAIToolsAgent } from "langchain/agents";
import { AgentExecutor } from "langchain/agents";
import { ChatPromptTemplate, MessagesPlaceholder } from "@langchain/core/prompts";
import { SYSTEM_PROMPT } from "../prompts/system.js";
import { BaseMessage } from "@langchain/core/messages";
import { getHistory } from "../memory/conversation.js";

interface ChatInput {
  input: string;
  chat_history: BaseMessage[];
}

const prompt = ChatPromptTemplate.fromMessages([
  ["system", SYSTEM_PROMPT],
  new MessagesPlaceholder("chat_history"),
  ["human", "{input}"],
  new MessagesPlaceholder("agent_scratchpad"),
]);

let chatAgent: AgentExecutor | null = null;

// LangChain v0.3 声明式配置
// 一个 prompt 模板 + createOpenAIToolsAgent + AgentExecutor
// 框架内部处理推理循环，无需手动管理工具调用逻辑
export function createChatAgent() {
  if (chatAgent) return chatAgent;

  const model = new ChatOpenAI({
    modelName: process.env.OPENAI_MODEL || "gpt-4o-mini",
    configuration: {
      baseURL: process.env.OPENAI_BASE_URL,
      apiKey: process.env.OPENAI_API_KEY,
    },
  });

  const agent = createOpenAIToolsAgent({
    llm: model as any,
    tools: [],
    prompt,
  });

  chatAgent = new AgentExecutor({ agent, tools: [], verbose: false });
  return chatAgent;
}

export async function chat(agent: AgentExecutor, message: string, threadId: string) {
  const history: BaseMessage[] = getHistory(threadId);

  const input: ChatInput = {
    input: message,
    chat_history: history,
  };

  const result = await agent.invoke(input);
  return { reply: result.output as string, threadId };
}
