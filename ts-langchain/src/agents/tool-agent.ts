import { ChatOpenAI } from "@langchain/openai";
import { AIMessage, BaseMessage, ToolMessage } from "@langchain/core/messages";
import { createAgent, createMiddleware } from "langchain";
import { TOOL_CALLING_PROMPT } from "../prompts/system.js";
import { tools, toolDescriptors, toolSchemas } from "../tools/index.js";
import { wrapToolWithRuntime } from "../tools/runtime/executor.js";
import { config } from "../config/index.js";
import {
  createDefaultReActLimits,
  getActiveReActTracker,
  ReActRunSummary,
  ReActRunTracker,
  runWithReActTracker,
} from "./react-policy.js";

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

// 按系统提示缓存声明式 Agent，避免重复构建模型和工具绑定。
const agentCache = new Map<string, Promise<DeclarativeToolAgent>>();
const MAX_CACHE_SIZE = 10;

// 将消息内容规范化为可返回给 API 的文本。
function getMessageText(message: BaseMessage | undefined): string {
  return message && typeof message.content === "string" ? message.content : "";
}

// 以 createAgent 封装旧调用约定，并保留现有服务层输入接口。
class DeclarativeToolAgent {
  readonly maxIterations = MAX_AGENT_ITERATIONS;

  // 初始化声明式 LangChain Agent。
  constructor(
    readonly agent: ReturnType<typeof createAgent>,
  ) {}

  // 调用 Agent 并将消息状态转换为旧接口的 output 字段。
  async invoke(
    input: { input: string; chat_history?: BaseMessage[]; memory_context?: BaseMessage[] },
    options: { signal?: AbortSignal } = {},
  ): Promise<{ output: string; react: ReActRunSummary }> {
    const tracker = createReActTracker();
    try {
      return await runWithReActTracker(tracker, async () => {
        const result = await this.agent.invoke(
          { messages: [...(input.memory_context || []), ...(input.chat_history || []), { role: "user", content: input.input }] },
          { signal: options.signal, recursionLimit: this.maxIterations * 3 + 4 },
        );
        const output = getMessageText((result.messages as BaseMessage[]).at(-1)) || "抱歉，我没有理解您的问题。";
        tracker.complete(output);
        return { output, react: tracker.summary() };
      });
    } catch (error) {
      tracker.fail(error);
      throw error;
    }
  }

  // 直接转发 LangChain 原生事件流，提供真实 token 和工具进度。
  async *streamEvents(
    input: { input: string; chat_history?: BaseMessage[]; memory_context?: BaseMessage[] },
    options: {
      signal?: AbortSignal;
      version?: "v1" | "v2";
      toolCallScope?: { run<T>(callback: () => T): T };
  } = {},
  ) {
    const tracker = createReActTracker();
    const events: unknown[] = [];
    let completed = false;
    let failed: unknown;
    let notify = () => {};
    const waitForEvent = () => new Promise<void>((resolve) => {
      notify = resolve;
    });
    const pump = async () => {
      try {
        const stream = this.agent.streamEvents(
      {
        messages: [
          ...(input.memory_context || []),
          ...(input.chat_history || []),
          { role: "user", content: input.input },
        ],
      },
      {
        signal: options.signal,
        recursionLimit: this.maxIterations * 3 + 4,
        version: options.version || "v2",
      },
        );
        for await (const event of stream) {
          events.push(event);
          notify();
        }
        events.push({ event: "on_chain_end", data: { output: { react: tracker.summary() } } });
        notify();
      } catch (error) {
        tracker.fail(error);
        failed = error;
      } finally {
        completed = true;
        notify();
      }
    };
    const runPump = () => runWithReActTracker(tracker, pump);
    const running = options.toolCallScope ? options.toolCallScope.run(runPump) : runPump();
    while (!completed || events.length > 0) {
      const event = events.shift();
      if (event) {
        yield event;
      } else {
        await waitForEvent();
      }
    }
    await running;
    if (failed) throw failed;
  }
}

// 为每个请求创建共享配置的独立 ReAct 策略状态。
function createReActTracker(): ReActRunTracker {
  return new ReActRunTracker(createDefaultReActLimits({
    maxSteps: config.REACT_MAX_STEPS,
    maxToolCalls: config.REACT_MAX_TOOL_CALLS,
    maxSameToolCalls: config.REACT_MAX_SAME_TOOL_CALLS,
    maxTotalTimeMs: config.REACT_MAX_TOTAL_TIME_MS,
  }));
}

// 将 createAgent 的模型与工具钩子映射到公共 ReAct 策略，而不重写框架循环。
function createReActPolicyMiddleware() {
  return createMiddleware({
    name: "ReActPolicyMiddleware",
    // 在模型调用前限制步骤，并在停止后只允许模型生成最终答案。
    wrapModelCall: async (request, handler) => {
      const tracker = getActiveReActTracker();
      const finalOnly = tracker?.beginModelCall() || false;
      const response = await handler(finalOnly
        ? { ...request, tools: [], toolChoice: "none", systemPrompt: `${request.systemPrompt || ""}\n\n工具调用已因安全限制停止。请只基于已有结果给出最终回答，不要请求工具，也不要展示内部推理。` }
        : request);
      const normalized = convertXmlToolCalls(response) as AIMessage;
      if (!normalized.tool_calls?.length) tracker?.complete(getMessageText(normalized));
      return normalized;
    },
    // 在工具调用前后记录执行事实，并把可恢复错误作为 ToolMessage 交还框架。
    wrapToolCall: async (request, handler) => {
      const tracker = getActiveReActTracker();
      if (!tracker) return handler(request);
      const toolName = request.toolCall.name || "tool";
      const toolCallId = request.toolCall.id || `call_${toolName}`;
      const attempt = tracker.beforeTool(toolName, request.toolCall.args || {});
      if (!attempt.allowed) {
        return new ToolMessage({ content: "工具调用已达到本次请求的安全限制。请基于已有结果回答用户。", tool_call_id: toolCallId, name: toolName });
      }
      const startedAt = Date.now();
      try {
        const result = await handler(request);
        const toolError = result instanceof ToolMessage && result.status === "error";
        tracker.recordTool(toolCallId, toolName, attempt.signature, startedAt, result instanceof ToolMessage ? result.content : result, toolError ? new Error(String(result.content)) : undefined);
        return result;
      } catch (error) {
        tracker.recordTool(toolCallId, toolName, attempt.signature, startedAt, null, error);
        return new ToolMessage({ content: `Error: ${error instanceof Error ? error.message : "工具执行失败"}`, tool_call_id: toolCallId, name: toolName, status: "error" });
      }
    },
  });
}

// 创建或获取声明式 ReAct 工具 Agent。
export async function createToolAgent(
  systemPromptOverride?: string,
): Promise<DeclarativeToolAgent> {
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

// 构建带 Runtime 工具管线的声明式 createAgent 实例。
async function buildToolAgent(systemPrompt: string): Promise<DeclarativeToolAgent> {
  const rawModel = new ChatOpenAI({
    model: process.env.OPENAI_MODEL,
    timeout: config.LLM_TIMEOUT_MS,
    maxRetries: config.LLM_MAX_RETRIES,
    configuration: {
      baseURL: process.env.OPENAI_BASE_URL,
      apiKey: process.env.OPENAI_API_KEY,
    },
  });
  const wrappedTools = tools.map((tool) => {
    const descriptor = toolDescriptors[tool.name];
    const schema = toolSchemas[tool.name];
    return descriptor ? wrapToolWithRuntime(tool, descriptor, schema) : tool;
  });
  return new DeclarativeToolAgent(
    createAgent({
      model: rawModel,
      tools: wrappedTools as any,
      systemPrompt,
      middleware: [createReActPolicyMiddleware()],
    }),
  );
}
