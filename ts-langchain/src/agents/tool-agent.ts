import { ChatOpenAI } from "@langchain/openai";
import { createOpenAIToolsAgent } from "langchain/agents";
import { AgentExecutor } from "langchain/agents";
import { ChatPromptTemplate, MessagesPlaceholder } from "@langchain/core/prompts";
import { TOOL_CALLING_PROMPT } from "../prompts/system.js";
import { tools } from "../tools/index.js";

const prompt = ChatPromptTemplate.fromMessages([
  ["system", "{system_prompt}"],
  new MessagesPlaceholder("chat_history"),
  ["human", "{input}"],
  new MessagesPlaceholder("agent_scratchpad"),
]);

let toolAgent: Promise<AgentExecutor> | null = null;

export async function createToolAgent(systemPromptOverride?: string): Promise<AgentExecutor> {
  if (toolAgent) return toolAgent;

  toolAgent = buildToolAgent(systemPromptOverride);
  return toolAgent;
}

async function buildToolAgent(systemPromptOverride?: string): Promise<AgentExecutor> {

  const model = new ChatOpenAI({
    modelName: process.env.OPENAI_MODEL,
    configuration: {
      baseURL: process.env.OPENAI_BASE_URL,
      apiKey: process.env.OPENAI_API_KEY,
    },
  });

  const systemPrompt = systemPromptOverride || TOOL_CALLING_PROMPT;

  const dynamicPrompt = ChatPromptTemplate.fromMessages([
    ["system", systemPrompt],
    new MessagesPlaceholder("chat_history"),
    ["human", "{input}"],
    new MessagesPlaceholder("agent_scratchpad"),
  ]);

  const agent = await createOpenAIToolsAgent({
    llm: model as any,
    tools: tools as any,
    prompt: dynamicPrompt,
  });

  return new AgentExecutor({ agent: agent as any, tools: tools as any, verbose: false });
}
