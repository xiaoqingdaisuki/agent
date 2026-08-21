import {
  AIMessage,
  BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import type { DynamicStructuredTool } from "langchain/tools";

// ReAct 执行状态，内部状态只用于结构化观测，不包含思维链正文。
export type ReActState =
  | "IDLE"
  | "REASONING"
  | "TOOL_CALLING"
  | "OBSERVING"
  | "ANSWERING"
  | "COMPLETED"
  | "FAILED"
  | "TIMEOUT"
  | "TOOL_ERROR"
  | "MAX_STEPS_REACHED";

// ReAct 终止原因，接口对外只暴露稳定枚举值。
export type ReActStopReason =
  | "ANSWER_COMPLETE"
  | "CLARIFICATION_REQUIRED"
  | "MAX_STEPS"
  | "TIMEOUT"
  | "TOOL_FAILURE"
  | "ERROR";

// 工具调用后的统一 Observation 信封。
export interface ReActObservation {
  tool_call_id: string;
  tool: string;
  status: "success" | "error";
  data: unknown;
  error: { code: string; message: string } | null;
  latency_ms: number;
}

// ReAct 运行限制，默认值与 V1 需求文档保持一致。
export interface ReActLimits {
  maxSteps: number;
  maxToolCalls: number;
  maxSameToolCalls: number;
  maxTotalTimeMs: number;
  maxRetriesPerCall: number;
}

// ReAct 请求结束后的结构化摘要。
export interface ReActRunSummary {
  state: ReActState;
  stop_reason: ReActStopReason;
  react_steps: number;
  tool_calls: number;
  tool_names: string[];
  tool_errors: number;
  model_calls: number;
  observations: ReActObservation[];
  reason_code?: string;
  total_latency_ms: number;
}

// ReAct 运行时事件，供 SSE 层映射为可观察状态。
export type ReActRuntimeEvent =
  | { event: "agent.start" }
  | { event: "tool.start"; tool: string; callId: string }
  | { event: "tool.complete"; tool: string; callId: string; latencyMs: number }
  | { event: "tool.error"; tool: string; callId: string; latencyMs: number; code: string }
  | { event: "agent.answer.delta"; text: string }
  | { event: "agent.complete"; summary: ReActRunSummary };

// ReAct 执行器输入结构，兼容现有 LangChain AgentService 调用方式。
export interface ReActAgentInput {
  input: string;
  chat_history?: BaseMessage[];
  memory_context?: BaseMessage[];
}

// ReAct 执行器返回结构，保留 output 字段兼容旧 API。
export interface ReActAgentResult {
  output: string;
  react: ReActRunSummary;
}

// ReAct 执行器选项。
interface ReActInvokeOptions {
  signal?: AbortSignal;
  toolCallScope?: { run<T>(callback: () => T): T };
}

// 将任意 LangChain 内容转换为可传给模型的文本。
function messageText(message: BaseMessage): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map((part: any) => (typeof part === "string" ? part : part?.text || ""))
    .join("");
}

// 将工具返回字符串解析为结构化数据，解析失败时保留原文。
function parseObservationData(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

// 生成稳定的工具和参数签名，用于检测重复调用。
function toolCallSignature(tool: string, args: unknown): string {
  return `${tool}:${JSON.stringify(args, Object.keys((args as object) || {}).sort())}`;
}

// 判断错误是否属于用户主动中止或截止时间中止。
function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  return Boolean(
    signal?.aborted ||
      (error instanceof Error &&
        (error.name === "AbortError" || error.name === "TimeoutError")),
  );
}

// 自定义 ReAct 执行器，显式控制 Reason、Act、Observation 和停止条件。
export class ReActAgentExecutor {
  readonly maxIterations: number;
  readonly agent: {
    returnStoppedResponse: (
      method: string,
      steps: unknown[],
    ) => Promise<{ returnValues: { output: string }; log: string }>;
  };

  private readonly model: any;
  private readonly boundModel: any;
  private readonly tools: DynamicStructuredTool[];
  private readonly systemPrompt: string;
  private readonly limits: ReActLimits;
  private lastRun?: ReActRunSummary;

  // 初始化 ReAct 执行器并绑定可用工具。
  constructor(
    model: any,
    tools: DynamicStructuredTool[],
    systemPrompt: string,
    limits: ReActLimits,
  ) {
    this.model = model;
    this.tools = tools;
    this.systemPrompt = systemPrompt;
    this.limits = limits;
    this.maxIterations = limits.maxSteps;
    this.boundModel = model.bindTools(tools);
    this.agent = {
      returnStoppedResponse: async () => ({
        returnValues: {
          output:
            "我已达到本次 ReAct 执行上限，无法继续调用工具。请缩小问题范围或补充必要信息。",
        },
        log: "",
      }),
    };
  }

  // 返回最近一次请求的结构化 ReAct 摘要。
  getLastRun(): ReActRunSummary | undefined {
    return this.lastRun;
  }

  // 执行一轮 ReAct 请求并返回最终答案。
  async invoke(
    input: ReActAgentInput,
    options: ReActInvokeOptions = {},
  ): Promise<ReActAgentResult> {
    return this.execute(input, options);
  }

  // 以 LangChain 兼容形式返回完整答案，供旧版流式回退路径使用。
  async *stream(
    input: ReActAgentInput,
    options: ReActInvokeOptions = {},
  ): AsyncGenerator<ReActAgentResult, void, unknown> {
    yield await this.execute(input, options);
  }

  // 以 LangChain 事件格式暴露工具状态和答案增量，不暴露内部思维内容。
  async *streamEvents(
    input: ReActAgentInput,
    options: ReActInvokeOptions = {},
  ): AsyncGenerator<any, void, unknown> {
    const events: ReActRuntimeEvent[] = [];
    const result = await this.execute(input, options, (event) => events.push(event));
    for (const event of events) {
      if (event.event === "agent.answer.delta") {
        yield {
          event: "on_chat_model_stream",
          data: { chunk: new AIMessage(event.text) },
        };
      } else if (event.event === "tool.start") {
        yield { event: "on_tool_start", name: event.tool, run_id: event.callId };
      } else if (event.event === "tool.complete") {
        yield { event: "on_tool_end", name: event.tool, run_id: event.callId };
      } else if (event.event === "tool.error") {
        yield { event: "on_tool_error", name: event.tool, run_id: event.callId };
      } else if (event.event === "agent.complete") {
        yield { event: "on_chain_end", data: { output: result } };
      }
    }
  }

  // 执行 ReAct 主循环。
  private async execute(
    input: ReActAgentInput,
    options: ReActInvokeOptions,
    onEvent?: (event: ReActRuntimeEvent) => void,
  ): Promise<ReActAgentResult> {
    const startedAt = Date.now();
    const observations: ReActObservation[] = [];
    const toolNames: string[] = [];
    const signatures = new Map<string, number>();
    let state: ReActState = "IDLE";
    let stopReason: ReActStopReason = "ERROR";
    let steps = 0;
    let toolCalls = 0;
    let toolErrors = 0;
    let modelCalls = 0;
    let reasonCode: string | undefined;
    const failedSignatures = new Set<string>();
    const messages: BaseMessage[] = [
      new SystemMessage(this.systemPrompt),
      ...(input.memory_context || []),
      ...(input.chat_history || []),
      new HumanMessage(input.input),
    ];
    onEvent?.({ event: "agent.start" });

    try {
      while (true) {
        if (Date.now() - startedAt >= this.limits.maxTotalTimeMs) {
          state = "TIMEOUT";
          stopReason = "TIMEOUT";
          reasonCode = "TOTAL_TIME_LIMIT";
          const output = await this.finalAnswer(messages, observations, input.input, options);
          return this.finish(output, state, stopReason, steps, toolCalls, toolNames, toolErrors, modelCalls, observations, reasonCode, startedAt, onEvent);
        }
        if (steps >= this.limits.maxSteps) {
          state = "MAX_STEPS_REACHED";
          stopReason = "MAX_STEPS";
          reasonCode = "MAX_REACT_STEPS";
          const output = await this.finalAnswer(messages, observations, input.input, options);
          return this.finish(output, state, stopReason, steps, toolCalls, toolNames, toolErrors, modelCalls, observations, reasonCode, startedAt, onEvent);
        }

        state = "REASONING";
        steps += 1;
        const response = await this.boundModel.invoke(messages, { signal: options.signal });
        modelCalls += 1;
        const normalized = response as AIMessage;
        messages.push(normalized);
        const toolCallsFromModel = normalized.tool_calls || [];
        if (toolCallsFromModel.length === 0) {
          state = "ANSWERING";
          stopReason = this.isClarification(messageText(normalized))
            ? "CLARIFICATION_REQUIRED"
            : "ANSWER_COMPLETE";
          reasonCode = stopReason === "CLARIFICATION_REQUIRED" ? "MISSING_REQUIRED_INPUT" : undefined;
          const output = messageText(normalized) || "抱歉，我没有理解您的问题。";
          return this.finish(output, "COMPLETED", stopReason, steps, toolCalls, toolNames, toolErrors, modelCalls, observations, reasonCode, startedAt, onEvent);
        }

        state = "TOOL_CALLING";
        let shouldStop = false;
        for (const call of toolCallsFromModel) {
          const callName = call.name || "unknown";
          const callId = call.id || `call_${callName}_${toolCalls + 1}`;
          const tool = this.tools.find((candidate) => candidate.name === callName);
          const signature = toolCallSignature(callName, call.args || {});
          const sameCallCount = (signatures.get(signature) || 0) + 1;
          signatures.set(signature, sameCallCount);
          if (toolCalls >= this.limits.maxToolCalls) {
            shouldStop = true;
            stopReason = "MAX_STEPS";
            reasonCode = "MAX_TOOL_CALLS";
            break;
          }
          if (sameCallCount > this.limits.maxSameToolCalls) {
            shouldStop = true;
            stopReason = "TOOL_FAILURE";
            reasonCode = "REPEATED_TOOL_CALL";
            break;
          }
          if (
            failedSignatures.has(signature) &&
            sameCallCount > this.limits.maxRetriesPerCall + 1
          ) {
            shouldStop = true;
            stopReason = "TOOL_FAILURE";
            reasonCode = "TOOL_RETRY_EXHAUSTED";
            break;
          }
          if (!tool) {
            const observation: ReActObservation = {
              tool_call_id: callId,
              tool: callName,
              status: "error",
              data: null,
              error: { code: "NOT_FOUND", message: `未找到工具: ${callName}` },
              latency_ms: 0,
            };
            observations.push(observation);
            toolErrors += 1;
            messages.push(new ToolMessage({ content: JSON.stringify(observation), tool_call_id: callId, name: callName }));
            onEvent?.({ event: "tool.error", tool: callName, callId, latencyMs: 0, code: "NOT_FOUND" });
            continue;
          }

          toolCalls += 1;
          toolNames.push(callName);
          const callStartedAt = Date.now();
          onEvent?.({ event: "tool.start", tool: callName, callId });
          try {
            const invokeTool = () => tool.invoke(call.args || {}, { signal: options.signal });
            const raw = await (options.toolCallScope
              ? options.toolCallScope.run(invokeTool)
              : invokeTool());
            const observation: ReActObservation = {
              tool_call_id: callId,
              tool: callName,
              status: "success",
              data: typeof raw === "string" ? parseObservationData(raw) : raw,
              error: null,
              latency_ms: Date.now() - callStartedAt,
            };
            observations.push(observation);
            state = "OBSERVING";
            messages.push(new ToolMessage({ content: JSON.stringify(observation), tool_call_id: callId, name: callName }));
            onEvent?.({ event: "tool.complete", tool: callName, callId, latencyMs: observation.latency_ms });
          } catch (error: unknown) {
            const code = error instanceof Error && error.name === "AbortError" ? "TIMEOUT" : "INTERNAL_ERROR";
            const message = error instanceof Error ? error.message : "工具执行失败";
            const observation: ReActObservation = {
              tool_call_id: callId,
              tool: callName,
              status: "error",
              data: null,
              error: { code, message },
              latency_ms: Date.now() - callStartedAt,
            };
            observations.push(observation);
            toolErrors += 1;
            state = "TOOL_ERROR";
            failedSignatures.add(signature);
            messages.push(new ToolMessage({ content: JSON.stringify(observation), tool_call_id: callId, name: callName }));
            onEvent?.({ event: "tool.error", tool: callName, callId, latencyMs: observation.latency_ms, code });
          }
        }
        if (shouldStop) {
          state = stopReason === "TOOL_FAILURE" ? "TOOL_ERROR" : "MAX_STEPS_REACHED";
          const output = await this.finalAnswer(messages.slice(0, -1), observations, input.input, options);
          return this.finish(output, state, stopReason, steps, toolCalls, toolNames, toolErrors, modelCalls, observations, reasonCode, startedAt, onEvent);
        }
      }
    } catch (error: unknown) {
      if (isAbortError(error, options.signal)) {
        state = "TIMEOUT";
        stopReason = "TIMEOUT";
        reasonCode = "REQUEST_ABORTED";
      } else {
        state = "FAILED";
        stopReason = "ERROR";
        reasonCode = "UNRECOVERABLE_ERROR";
      }
      const output = observations.length
        ? "工具执行未能完整结束。以下是已确认的信息；如需继续，请稍后重试。"
        : "抱歉，本次请求未能完成。请稍后重试。";
      return this.finish(output, state, stopReason, steps, toolCalls, toolNames, toolErrors, modelCalls, observations, reasonCode, startedAt, onEvent);
    }
  }

  // 在达到安全限制时生成不暴露内部思维的最终答复。
  private async finalAnswer(
    messages: BaseMessage[],
    observations: ReActObservation[],
    question: string,
    options: ReActInvokeOptions,
  ): Promise<string> {
    const safeMessages = messages.filter(
      (message) =>
        !(message instanceof AIMessage && message.tool_calls?.length) &&
        !(message instanceof ToolMessage),
    );
    try {
      const response = await this.model.invoke([
        ...safeMessages,
        new SystemMessage(
          `Observation:\n${JSON.stringify(observations).slice(0, 12_000)}`,
        ),
        new SystemMessage(
          `ReAct 执行已停止。请仅基于已返回的 Observation 回答用户，不要调用工具、不要展示内部推理。用户问题：${question}\n已收集 Observation 数量：${observations.length}`,
        ),
      ], { signal: options.signal });
      return messageText(response) || "我已停止继续调用工具，但目前掌握的信息不足以完成回答。";
    } catch {
      return observations.length
        ? "我已停止继续调用工具，以下是目前已确认的信息。请根据需要缩小问题范围后重试。"
        : "我已停止继续调用工具，目前没有收集到足够信息。请稍后重试。";
    }
  }

  // 判断模型输出是否是澄清问题，避免把必要追问误记为普通答案。
  private isClarification(text: string): boolean {
    return /请问|需要提供|哪个城市|请补充|能否提供|想查询哪/i.test(text) && text.trim().endsWith("？");
  }

  // 完成一次请求并保存结构化摘要，同时发送完成事件。
  private finish(
    output: string,
    state: ReActState,
    stopReason: ReActStopReason,
    steps: number,
    toolCalls: number,
    toolNames: string[],
    toolErrors: number,
    modelCalls: number,
    observations: ReActObservation[],
    reasonCode: string | undefined,
    startedAt: number,
    onEvent?: (event: ReActRuntimeEvent) => void,
  ): ReActAgentResult {
    const summary: ReActRunSummary = {
      state,
      stop_reason: stopReason,
      react_steps: steps,
      tool_calls: toolCalls,
      tool_names: [...toolNames],
      tool_errors: toolErrors,
      model_calls: modelCalls,
      observations: [...observations],
      reason_code: reasonCode,
      total_latency_ms: Date.now() - startedAt,
    };
    this.lastRun = summary;
    onEvent?.({ event: "agent.answer.delta", text: output });
    onEvent?.({ event: "agent.complete", summary });
    return { output, react: summary };
  }
}

// 创建符合需求文档默认值的 ReAct 限制配置。
export function createDefaultReActLimits(overrides: Partial<ReActLimits> = {}): ReActLimits {
  return {
    maxSteps: 8,
    maxToolCalls: 6,
    maxSameToolCalls: 3,
    maxTotalTimeMs: 30_000,
    maxRetriesPerCall: 1,
    ...overrides,
  };
}
