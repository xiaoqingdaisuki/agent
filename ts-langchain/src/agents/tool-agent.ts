import { ChatOpenAI } from "@langchain/openai";
import { AIMessage, BaseMessage, ToolMessage } from "@langchain/core/messages";
import { createAgent, createMiddleware } from "langchain";
import { TOOL_CALLING_PROMPT } from "../prompts/system.js";
import { SYSTEM_PROMPT } from "../prompts/system.js";
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

// 将字符串或内容块数组转换为可用于 XML 检测和 API 回退的文本。
function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "text" in part) return String((part as { text?: unknown }).text || "");
      return "";
    })
    .join("");
}

type ParsedXmlToolCall = {
  name: string;
  args: Record<string, string>;
  start: number;
  end: number;
};

const TOOL_NAME_ALIASES: Record<string, string> = {
  search: "web_search",
  "weather.current": "get_weather",
  "web.search": "web_search",
  "web.read": "web_read",
  "web.extract": "web_extract",
  "time.current": "get_current_time",
  "time.convert": "convert_timezone",
  "math.calculate": "calculator",
  "knowledge.search": "knowledge_search",
  "file.search": "file_search",
  "memory.session.search": "memory_session_search",
  "memory.user.search": "memory_user_search",
  "memory.user.save": "memory_user_save",
  "memory.user.list": "memory_user_list",
  "memory.user.delete": "memory_user_delete",
};

// 将供应商使用的 Descriptor 名称映射为 LangChain 实际注册的工具名称。
function normalizeToolName(name: string): string {
  return TOOL_NAME_ALIASES[name] || name;
}

// 规范化标准 tool_calls，兼容供应商把 descriptor 名称直接作为调用名称。
function normalizeToolCalls(calls: unknown[]): unknown[] {
  return calls.map((call) => {
    if (!call || typeof call !== "object") return call;
    const candidate = call as Record<string, any>;
    if (typeof candidate.name === "string") {
      return { ...candidate, name: normalizeToolName(candidate.name) };
    }
    if (candidate.function && typeof candidate.function.name === "string") {
      return {
        ...candidate,
        function: {
          ...candidate.function,
          name: normalizeToolName(candidate.function.name),
        },
      };
    }
    return call;
  });
}

// 解码模型工具参数中的常见 XML 实体，避免把转义文本传给工具。
function decodeXmlText(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

// 解析一次 XML 工具调用中的参数，兼容两种供应商标签格式。
function parseXmlParameters(body: string): Record<string, string> {
  const args: Record<string, string> = {};
  const patterns = [
    /<parameter\s+name\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/parameter\s*>/gi,
    /<parameter\s*=\s*([^\s>]+)\s*>([\s\S]*?)<\/parameter\s*>/gi,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(body)) !== null) {
      args[decodeXmlText(match[1].trim())] = decodeXmlText(match[2].trim());
    }
  }
  return args;
}

// 提取模型返回的 invoke/function XML，并记录原文范围以便从最终回答中移除。
function parseXmlToolCalls(content: string): ParsedXmlToolCall[] {
  const matches: ParsedXmlToolCall[] = [];
  const patterns = [
    /<invoke\s+name\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/invoke\s*>/gi,
    /<function\s*=\s*([^\s>]+)\s*>([\s\S]*?)<\/function\s*>/gi,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      matches.push({
        name: decodeXmlText(match[1].trim()),
        args: parseXmlParameters(match[2]),
        start: match.index,
        end: match.index + match[0].length,
      });
    }
  }
  const dotsPattern = /<dots_function_call\s*>\s*<([a-z][\w.-]*)\s*>([\s\S]*?)<\/\1\s*>\s*<\/dots_function_call\s*>/gi;
  let dotsMatch: RegExpExecArray | null;
  while ((dotsMatch = dotsPattern.exec(content)) !== null) {
    const toolName = normalizeToolName(dotsMatch[1].trim());
    const body = dotsMatch[2];
    const queries = [...body.matchAll(/<query\s*>([\s\S]*?)<\/query\s*>/gi)];
    if (queries.length > 0) {
      for (const query of queries) {
        matches.push({
          name: toolName,
          args: { query: decodeXmlText(query[1]) },
          start: dotsMatch.index,
          end: dotsMatch.index + dotsMatch[0].length,
        });
      }
    } else {
      matches.push({
        name: toolName,
        args: {},
        start: dotsMatch.index,
        end: dotsMatch.index + dotsMatch[0].length,
      });
    }
  }
  return matches.sort((left, right) => left.start - right.start);
}

// 从回答中移除兼容协议文本，但不改变模型已经返回的原生工具调用。
function removeXmlToolCallText(content: string, calls: ParsedXmlToolCall[]): string {
  let cleanContent = content;
  const removedRanges = new Set<string>();
  for (const call of [...calls].sort((left, right) => right.start - left.start)) {
    const range = `${call.start}:${call.end}`;
    if (removedRanges.has(range)) continue;
    removedRanges.add(range);
    cleanContent = cleanContent.slice(0, call.start) + cleanContent.slice(call.end);
  }
  return cleanContent.trim();
}

// 将任意模型响应规范化为当前 LangChain 运行时可识别的 AIMessage，并兼容 XML 工具调用。
export function convertXmlToolCalls(message: unknown): AIMessage {
  const candidate = message as Partial<BaseMessage> | null;
  const rawContent = candidate?.content ?? "";
  const content = contentToText(rawContent);
  const originalToolCalls = Array.isArray((candidate as any)?.tool_calls)
    ? (candidate as any).tool_calls
    : [];
  const parsedCalls = parseXmlToolCalls(content);
  if (originalToolCalls.length > 0) {
    return new AIMessage({
      // 原生 tool_calls 是模型与当前 Agent 协商出的正式结果，兼容 XML 只允许被隐藏，不能覆盖或追加执行。
      content: parsedCalls.length > 0 ? removeXmlToolCallText(content, parsedCalls) : rawContent as any,
      tool_calls: normalizeToolCalls(originalToolCalls) as any,
      id: candidate?.id,
      response_metadata: candidate?.response_metadata,
      additional_kwargs: (candidate as any)?.additional_kwargs,
    });
  }
  if (parsedCalls.length === 0) {
    return new AIMessage({
      content: rawContent as any,
      tool_calls: normalizeToolCalls(originalToolCalls) as any,
      id: candidate?.id,
      response_metadata: candidate?.response_metadata,
      additional_kwargs: (candidate as any)?.additional_kwargs,
    });
  }

  const toolCalls = parsedCalls.map((call, index) => ({
    id: `call_${normalizeToolName(call.name)}_${index + 1}`,
    type: "tool_call" as const,
    name: normalizeToolName(call.name),
    args: call.args,
  }));
  return new AIMessage({
    content: removeXmlToolCallText(content, parsedCalls),
    tool_calls: toolCalls,
    id: candidate?.id,
    response_metadata: candidate?.response_metadata,
    additional_kwargs: (candidate as any)?.additional_kwargs,
  });
}

// 按系统提示缓存声明式 Agent，避免重复构建模型和工具绑定。
const agentCache = new Map<string, Promise<DeclarativeToolAgent>>();
const directAgentCache = new Map<string, Promise<DeclarativeToolAgent>>();
const MAX_CACHE_SIZE = 10;
export const MAX_STREAM_EVENT_BUFFER = 128;
type ModelWaiter = {
  resolve: () => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  timer?: ReturnType<typeof setTimeout>;
};
const modelWaiters: ModelWaiter[] = [];
let activeModelCalls = 0;

// 在模型服务可承受的并发范围内执行调用，避免上游排队造成请求长尾。
async function runWithModelCapacity<T>(
  operation: () => T | Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) throw signal.reason || new DOMException("Aborted", "AbortError");
  if (activeModelCalls < config.LLM_MAX_CONCURRENCY) {
    activeModelCalls += 1;
  } else {
    if (modelWaiters.length >= config.LLM_QUEUE_MAX) {
      throw Object.assign(new Error("Model capacity queue is full"), { code: "RATE_LIMITED" });
    }
    await new Promise<void>((resolve, reject) => {
      const waiter: ModelWaiter = {
        resolve: () => {
          if (waiter.timer) clearTimeout(waiter.timer);
          resolve();
        },
        reject,
        signal,
      };
      const onAbort = () => {
        const index = modelWaiters.indexOf(waiter);
        if (index >= 0) modelWaiters.splice(index, 1);
        if (waiter.timer) clearTimeout(waiter.timer);
        reject(signal?.reason || new DOMException("Aborted", "AbortError"));
      };
      waiter.onAbort = onAbort;
      waiter.timer = setTimeout(() => {
        const index = modelWaiters.indexOf(waiter);
        if (index >= 0) modelWaiters.splice(index, 1);
        signal?.removeEventListener("abort", onAbort);
        reject(Object.assign(new Error("Model capacity queue timed out"), { code: "RATE_LIMITED" }));
      }, config.LLM_QUEUE_TIMEOUT_MS);
      signal?.addEventListener("abort", onAbort, { once: true });
      modelWaiters.push(waiter);
    });
  }
  try {
    return await operation();
  } finally {
    let transferred = false;
    while (modelWaiters.length > 0) {
      const waiter = modelWaiters.shift();
      if (!waiter) break;
      waiter.signal?.removeEventListener("abort", waiter.onAbort!);
      if (waiter.timer) clearTimeout(waiter.timer);
      if (waiter.signal?.aborted) {
        waiter.reject(waiter.signal.reason || new DOMException("Aborted", "AbortError"));
        continue;
      }
      // 将当前占用的槽位直接转交给队首，避免新请求在等待者恢复前插队。
      waiter.resolve();
      transferred = true;
      break;
    }
    if (!transferred) activeModelCalls -= 1;
  }
}

// 集中定义必须保留完整工具链的意图，避免实时、文件或记忆请求被误送到轻量模型路径。
const TOOL_INTENT_PATTERNS = [
  /(?:天气|气温|下雨|下雪|空气质量|weather)/i,
  /(?:(?:现在|当前|此刻).{0,10}(?:几点|时间|日期|星期)|北京时间|时区|timezone)/i,
  /(?:(?:请|帮我|麻烦)?(?:计算(?!机)|算一下|算出)|\d\s*(?:[+\-*/×÷%^]|\*\*)\s*\d|\b(?:calculate|compute|evaluate)\b)/i,
  /(?:搜索|查一下|联网|浏览网页|打开网页|访问网址|web_search|web_read|https?:\/\/|\b(?:search|browse|look\s+up)\b)/i,
  /(?:(?:最新|实时|今天).{0,12}(?:新闻|消息|数据|价格|股价|汇率|比分|排名|航班)|(?:股价|汇率|比分|航班).{0,8}(?:多少|查询|今天|最新))/i,
  /(?:(?:换算|转换|换成|convert).{0,20}(?:时间|时区)|(?:时间|时区).{0,20}(?:换算|转换|换成)|\btimezone\b)/i,
  /(?:(?:读取|打开|搜索|查找|总结).{0,8}(?:文件|文档|附件)|(?:文件|文档|附件)中|file_id|知识库|资料库|(?:上传|附件|uploaded|attachment).{0,12}(?:pdf|docx?|txt|csv|xlsx?|pptx?))/i,
  /(?:记住|你记得|我的记忆|我的偏好|忘记我|删除.{0,8}记忆|保存.{0,8}(?:偏好|记忆)|memory_user|\bwho\s+am\s+i\b|\bwhat\s+do\s+you\s+remember)/i,
  /(?:(?:推荐|有什么).{0,12}(?:好吃|好玩|餐厅|酒店|景点|路线|行程)|(?:美食|游玩|餐厅|酒店|景点).{0,8}(?:推荐|攻略)|\brecommend.{0,20}(?:restaurant|hotel|attraction|trip))/i,
  /(?:谁是|何时|哪年|哪一年|哪位|多少人口|成立于|发布于|\bwho\s+is\b|\bwhen\s+did\b|\bwhat\s+year\b)/i,
  /(?:get_weather|get_current_time|convert_timezone|calculator|knowledge_search|file_search)/i,
];

// 仅白名单明确的普通生成任务进入无工具路径，未识别请求继续走保守路由。
const DIRECT_CHAT_PATTERNS = [
  /^(?:你好|您好|嗨|hi|hello|在吗|谢谢|感谢|晚安|早上好|下午好|晚上好|你是谁|你叫什么|介绍一下你自己|你能做什么|你会做什么|你的能力是什么)[！!。.?？]?$/i,
  /(?:解释|说明|什么是|为什么|如何理解|科普|讲讲|介绍|\bexplain\b|\bwhat\s+is\b|\bwhy\b)/i,
  /(?:翻译|译成|\btranslate\b)/i,
  /(?:(?:写|撰写|改写|润色|创作|生成).{0,24}(?:文案|欢迎语|故事|邮件|摘要|代码|函数|脚本|sql|正则)|(?:代码|函数|脚本|sql|正则).{0,20}(?:写|实现|示例)|\b(?:write|implement).{0,24}(?:code|function|script|regex|sql))/i,
  /(?:(?:制定|安排|设计).{0,24}(?:计划|方案|步骤)|(?:比较|对比)|\b(?:compare|plan|draft|rewrite|summarize)\b)/i,
  /(?:只输出|用(?:一|两|三|四|\d+)句话|列出|归纳|(?:简要|深入)分析)/i,
];

// 判断消息是否明确需要工具，保守保留实时数据、计算、文件和记忆能力。
export function requiresToolMessage(content: string): boolean {
  const normalized = content.trim().toLowerCase();
  return TOOL_INTENT_PATTERNS.some((pattern) => pattern.test(normalized));
}

// 判断消息是否可安全走无工具的快速对话路径，避免普通回答携带完整工具定义。
export function isDirectChatMessage(content: string): boolean {
  const normalized = content.trim().toLowerCase();
  return Boolean(normalized)
    && !requiresToolMessage(normalized)
    && DIRECT_CHAT_PATTERNS.some((pattern) => pattern.test(normalized));
}

// 返回无需模型调用的高频短问答，避免简单问题受外部模型抖动影响。
export function getFastPathAnswer(content: string): string | undefined {
  const normalized = content.trim().toLowerCase().replace(/\s+/g, "");
  if (["你好", "您好", "嗨", "hi", "hello"].includes(normalized)) {
    return "你好！我是 AI 老情，很高兴为你服务。";
  }
  if (["你是谁", "你叫什么"].includes(normalized)) {
    return "我是 AI 老情，可以帮你回答问题、整理信息和执行可用工具。";
  }
  if (["你能做什么", "你会做什么", "你的能力是什么"].includes(normalized)) {
    return "我可以回答问题、计算、检索公开信息，并协助规划和整理内容。";
  }
  if (/^1\+1(等于几|等于多少)?[?？。]?$/.test(normalized)) return "1 + 1 = 2。";
  if (normalized.includes("解释递归") || normalized.startsWith("什么是递归")) {
    return "递归是函数直接或间接调用自身，并在满足终止条件时停止。";
  }
  return undefined;
}

// 将消息内容规范化为可返回给 API 的文本。
function getMessageText(message: BaseMessage | undefined): string {
  return message ? contentToText(message.content) : "";
}

export type AgentContentBlock = Record<string, unknown>;
export type AgentUserContent = string | AgentContentBlock[];

// 以 createAgent 封装旧调用约定，并保留现有服务层输入接口。
class DeclarativeToolAgent {
  readonly maxIterations = MAX_AGENT_ITERATIONS;

  // 初始化声明式 LangChain Agent。
  constructor(
    readonly agent: ReturnType<typeof createAgent>,
  ) {}

  // 调用 Agent 并将消息状态转换为旧接口的 output 字段。
  async invoke(
    input: { input: AgentUserContent; chat_history?: BaseMessage[]; memory_context?: BaseMessage[] },
    options: { signal?: AbortSignal } = {},
  ): Promise<{ output: string; react: ReActRunSummary }> {
    const tracker = createReActTracker();
    try {
      return await runWithReActTracker(tracker, async () => {
        const result = await this.agent.invoke(
          { messages: [...(input.memory_context || []), ...(input.chat_history || []), { role: "user", content: input.input }] },
          { signal: options.signal, recursionLimit: this.maxIterations * 3 + 4 },
        );
        const answerMessage = [...(result.messages as BaseMessage[])]
          .reverse()
          .find((message) => {
            const messageType = typeof (message as any)?._getType === "function"
              ? (message as any)._getType()
              : (message as any)?.type;
            return messageType === "ai" || messageType === "assistant";
          });
        const output = getMessageText(answerMessage) || "抱歉，我没有理解您的问题。";
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
    input: { input: AgentUserContent; chat_history?: BaseMessage[]; memory_context?: BaseMessage[] },
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
    let notifyEvent = () => {};
    let notifySpace = () => {};
    // 等待上游产生事件，避免消费者空转轮询。
    const waitForEvent = () => new Promise<void>((resolve) => {
      notifyEvent = resolve;
    });
    // 缓冲区写满时反压上游模型事件，避免慢客户端导致进程内存无限增长。
    const waitForBufferSpace = () => new Promise<void>((resolve) => {
      notifySpace = resolve;
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
          while (events.length >= MAX_STREAM_EVENT_BUFFER) {
            await waitForBufferSpace();
          }
          events.push(event);
          notifyEvent();
        }
        while (events.length >= MAX_STREAM_EVENT_BUFFER) {
          await waitForBufferSpace();
        }
        events.push({ event: "on_chain_end", data: { output: { react: tracker.summary() } } });
        notifyEvent();
      } catch (error) {
        tracker.fail(error);
        failed = error;
      } finally {
        completed = true;
        notifyEvent();
      }
    };
    const runPump = () => runWithReActTracker(tracker, pump);
    const running = options.toolCallScope ? options.toolCallScope.run(runPump) : runPump();
    while (!completed || events.length > 0) {
      const event = events.shift();
      if (event) {
        notifySpace();
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
export function createReActPolicyMiddleware() {
  return createMiddleware({
    name: "ReActPolicyMiddleware",
    // 在模型调用前限制步骤，并在停止后只允许模型生成最终答案。
    wrapModelCall: async (request, handler) => {
      const tracker = getActiveReActTracker();
      const finalOnly = tracker?.beginModelCall() || false;
      const requestSignal = (request as unknown as { signal?: AbortSignal }).signal;
      const response = await runWithModelCapacity(
        () => handler(finalOnly
          ? { ...request, tools: [], toolChoice: "none", systemPrompt: `${request.systemPrompt || ""}\n\n工具调用已因安全限制停止。请只基于已有结果给出最终回答，不要请求工具，也不要展示内部推理。` }
          : request),
        requestSignal,
      );
      const normalized = convertXmlToolCalls(response);
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
        const toolResult = ToolMessage.isInstance(result)
          ? result
          : new ToolMessage({
              content: String((result as any)?.content || result),
              tool_call_id: toolCallId,
              name: toolName,
            });
        const toolError = toolResult.status === "error";
        tracker.recordTool(toolCallId, toolName, attempt.signature, startedAt, toolResult.content, toolError ? new Error(String(toolResult.content)) : undefined);
        return toolResult;
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
  void promise.catch(() => {
    if (agentCache.get(prompt) === promise) agentCache.delete(prompt);
  });
  return promise;
}

// 创建或获取不绑定工具的快速对话 Agent，用于明确不需要外部能力的消息。
export async function createDirectChatAgent(
  systemPromptOverride?: string,
): Promise<DeclarativeToolAgent> {
  const prompt = systemPromptOverride || SYSTEM_PROMPT;
  const cached = directAgentCache.get(prompt);
  if (cached) return cached;
  if (directAgentCache.size >= MAX_CACHE_SIZE) {
    const firstKey = directAgentCache.keys().next().value;
    if (firstKey) directAgentCache.delete(firstKey);
  }
  const promise = buildDirectChatAgent(prompt);
  directAgentCache.set(prompt, promise);
  void promise.catch(() => {
    if (directAgentCache.get(prompt) === promise) directAgentCache.delete(prompt);
  });
  return promise;
}

// 清空 ReAct Agent 缓存。
export function invalidateToolAgentCache(): void {
  agentCache.clear();
  directAgentCache.clear();
}

// 构建不发送工具 schema 的声明式 Agent，缩短首 token 延迟并保留流式事件契约。
async function buildDirectChatAgent(systemPrompt: string): Promise<DeclarativeToolAgent> {
  const rawModel = new ChatOpenAI({
    model: process.env.OPENAI_MODEL,
    maxTokens: config.LLM_MAX_OUTPUT_TOKENS,
    timeout: config.LLM_TIMEOUT_MS,
    maxRetries: config.LLM_MAX_RETRIES,
    configuration: {
      baseURL: process.env.OPENAI_BASE_URL,
      apiKey: process.env.OPENAI_API_KEY,
    },
  });
  return new DeclarativeToolAgent(createAgent({
    model: rawModel,
    systemPrompt,
    middleware: [createReActPolicyMiddleware()],
  }));
}

// 构建带 Runtime 工具管线的声明式 createAgent 实例。
async function buildToolAgent(systemPrompt: string): Promise<DeclarativeToolAgent> {
  const rawModel = new ChatOpenAI({
    model: process.env.OPENAI_MODEL,
    maxTokens: config.LLM_MAX_OUTPUT_TOKENS,
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
