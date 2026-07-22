import { ChatOpenAI } from "@langchain/openai";
import { createOpenAIToolsAgent } from "langchain/agents";
import { AgentExecutor } from "langchain/agents";
import { ChatPromptTemplate, MessagesPlaceholder } from "@langchain/core/prompts";
import { TOOL_CALLING_PROMPT } from "../prompts/system.js";
import { tools } from "../tools/index.js";

const prompt = ChatPromptTemplate.fromMessages([
  ["system", TOOL_CALLING_PROMPT],
  new MessagesPlaceholder("chat_history"),
  ["human", "{input}"],
  new MessagesPlaceholder("agent_scratchpad"),
]);

let toolAgent: Promise<AgentExecutor> | null = null;

// LangChain v0.3 声明式配置：
// - prompt 模板定义对话格式
// - createOpenAIToolsAgent 配置 LLM + 工具
// - AgentExecutor 包装，框架内部处理推理循环
// 对比 Python 版 LangGraph：需要显式定义图节点、边、条件路由
export async function createToolAgent(): Promise<AgentExecutor> {
  if (toolAgent) return toolAgent;

  toolAgent = buildToolAgent();
  return toolAgent;
}

async function buildToolAgent(): Promise<AgentExecutor> {

  const model = new ChatOpenAI({
    modelName: process.env.OPENAI_MODEL || "gpt-4o-mini",
    configuration: {
      baseURL: process.env.OPENAI_BASE_URL,
      apiKey: process.env.OPENAI_API_KEY,
    },
  });

  const agent = await createOpenAIToolsAgent({
    llm: model as any,
    tools: tools as any,
    prompt,
  });

  return new AgentExecutor({ agent: agent as any, tools: tools as any, verbose: false });
}
