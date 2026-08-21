import { ChatOpenAI } from "@langchain/openai";
import { AIMessage, BaseMessage } from "@langchain/core/messages";
import { TOOL_CALLING_PROMPT } from "../prompts/system.js";
import { tools, toolDescriptors, toolSchemas } from "../tools/index.js";
import { wrapToolWithRuntime } from "../tools/runtime/executor.js";
import {
  createDefaultReActLimits,
  ReActAgentExecutor,
} from "./react.js";
import { config } from "../config/index.js";

// ReAct 最大步骤与 Python 版共享配置，避免两种实现的安全边界不一致。
export const MAX_AGENT_ITERATIONS = config.REACT_MAX_STEPS;

// 将非 OpenAI 模型的 XML 格式工具调用转换为标准 AIMessage 格式。
export function convertXmlToolCalls(message: BaseMessage): BaseMessage {
  const content = typeof message.content === "string" ? message.content : "";
  const functionOpen = "<func" + "tion=";
  const functionClose = "</func" + "tion>";
  const parameterOpen = "<para" + "meter=";
  const parameterClose = "</para" + "meter>";
  if (!content.includes(functionOpen)) return message;

  const toolCalls: any[] = [];
  let position = 0;
  while (true) {
    const functionStart = content.indexOf(functionOpen, position);
    if (functionStart === -1) break;
    const nameEnd = content.indexOf(">", functionStart + functionOpen.length);
    if (nameEnd === -1) break;
    const name = content.substring(functionStart + functionOpen.length, nameEnd);
    const bodyStart = nameEnd + 1;
    const functionEnd = content.indexOf(functionClose, bodyStart);
    if (functionEnd === -1) break;
    const body = content.substring(bodyStart, functionEnd);
    const args: Record<string, string> = {};
    let parameterPosition = 0;
    while (true) {
      const parameterStart = body.indexOf(parameterOpen, parameterPosition);
      if (parameterStart === -1) break;
      const parameterNameEnd = body.indexOf(">", parameterStart + parameterOpen.length);
      if (parameterNameEnd === -1) break;
      const parameterName = body.substring(parameterStart + parameterOpen.length, parameterNameEnd);
      const valueStart = parameterNameEnd + 1;
      const valueEnd = body.indexOf(parameterClose, valueStart);
      if (valueEnd === -1) break;
      args[parameterName] = body.substring(valueStart, valueEnd).trim();
      parameterPosition = valueEnd + parameterClose.length;
    }
    toolCalls.push({
      id: `call_${name}_${toolCalls.length + 1}`,
      type: "tool_call",
      name,
      args,
    });
    position = functionEnd + functionClose.length;
  }
  if (toolCalls.length === 0) return message;

  let cleanContent = content;
  for (const call of toolCalls) {
    const startTag = `${functionOpen}${call.name}>`;
    const start = cleanContent.indexOf(startTag);
    if (start === -1) continue;
    const end = cleanContent.indexOf(functionClose, start);
    if (end !== -1) {
      cleanContent = cleanContent.substring(0, start) + cleanContent.substring(end + functionClose.length);
    }
  }
  return new AIMessage({ content: cleanContent.trim(), tool_calls: toolCalls });
}

// 在模型工具绑定结果外层包裹 XML 工具调用兼容逻辑。
function createModelWithXmlFix(model: ChatOpenAI): ChatOpenAI {
  const originalBindTools = model.bindTools.bind(model);
  (model as any).bindTools = (boundTools: any[]) => {
    const boundModel = originalBindTools(boundTools);
    const originalInvoke = boundModel.invoke.bind(boundModel);
    (boundModel as any).invoke = async (messages: BaseMessage[], options?: any) => {
      const response = await originalInvoke(messages as any, options);
      return convertXmlToolCalls(response as unknown as BaseMessage);
    };
    return boundModel;
  };
  return model;
}

// 按系统提示缓存 ReAct 执行器，避免重复构建模型和工具绑定。
const agentCache = new Map<string, Promise<ReActAgentExecutor>>();
const MAX_CACHE_SIZE = 10;

// 创建或获取 ReAct 工具 Agent。
export async function createToolAgent(
  systemPromptOverride?: string,
): Promise<ReActAgentExecutor> {
  const prompt = systemPromptOverride || TOOL_CALLING_PROMPT;
  const cached = agentCache.get(prompt);
  if (cached) return cached;
  if (agentCache.size >= MAX_CACHE_SIZE) {
    const firstKey = agentCache.keys().next().value;
    if (firstKey) agentCache.delete(firstKey);
  }
  const promise = buildToolAgent(prompt);
  agentCache.set(prompt, promise);
  return promise;
}

// 清空 ReAct Agent 缓存。
export function invalidateToolAgentCache(): void {
  agentCache.clear();
}

// 构建带 Runtime 工具管线的显式 ReAct 执行器。
async function buildToolAgent(systemPrompt: string): Promise<ReActAgentExecutor> {
  const rawModel = new ChatOpenAI({
    modelName: process.env.OPENAI_MODEL,
    timeout: config.LLM_TIMEOUT_MS,
    maxRetries: config.LLM_MAX_RETRIES,
    configuration: {
      baseURL: process.env.OPENAI_BASE_URL,
      apiKey: process.env.OPENAI_API_KEY,
    },
  });
  const model = createModelWithXmlFix(rawModel);
  const wrappedTools = tools.map((tool) => {
    const descriptor = toolDescriptors[tool.name];
    const schema = toolSchemas[tool.name];
    return descriptor ? wrapToolWithRuntime(tool, descriptor, schema) : tool;
  });
  return new ReActAgentExecutor(
    model,
    wrappedTools,
    systemPrompt,
    createDefaultReActLimits({
      maxSteps: config.REACT_MAX_STEPS,
      maxToolCalls: config.REACT_MAX_TOOL_CALLS,
      maxSameToolCalls: config.REACT_MAX_SAME_TOOL_CALLS,
      maxTotalTimeMs: config.REACT_MAX_TOTAL_TIME_MS,
      maxRetriesPerCall: 1,
    }),
  );
}
