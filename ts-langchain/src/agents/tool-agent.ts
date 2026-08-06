import { ChatOpenAI } from "@langchain/openai";
import { createOpenAIToolsAgent } from "langchain/agents";
import { AgentExecutor } from "langchain/agents";
import {
  ChatPromptTemplate,
  MessagesPlaceholder,
} from "@langchain/core/prompts";
import { AIMessage, BaseMessage } from "@langchain/core/messages";
import type { AgentStep } from "@langchain/core/agents";
import { TOOL_CALLING_PROMPT } from "../prompts/system.js";
import { tools, toolDescriptors, toolSchemas } from "../tools/index.js";
import { wrapToolWithRuntime } from "../tools/runtime/executor.js";
import { redactTextContent } from "../tools/runtime/data-redaction.js";
import { config } from "../config/index.js";

// Keep tool loops inside the end-to-end request budget, aligned with Python.
export const MAX_AGENT_ITERATIONS = config.MAX_AGENT_ITERATIONS;

// 将非 OpenAI 模型的 XML 格式工具调用转换为标准 AIMessage 格式
export function convertXmlToolCalls(message: BaseMessage): BaseMessage {
  const content = typeof message.content === "string" ? message.content : "";
  const F_O = "<func" + "tion=";
  const F_C = "</func" + "tion>";
  const P_O = "<para" + "meter=";
  const P_C = "</para" + "meter>";
  if (!content.includes(F_O)) return message;
  const toolCalls: any[] = [];
  let pos = 0;
  while (true) {
    const fs = content.indexOf(F_O, pos);
    if (fs === -1) break;
    const ne = content.indexOf(">", fs + F_O.length);
    if (ne === -1) break;
    const fn = content.substring(fs + F_O.length, ne);
    const ps = ne + 1;
    const fe = content.indexOf(F_C, ps);
    if (fe === -1) break;
    const pt = content.substring(ps, fe);
    const args: Record<string, string> = {};
    let pp = 0;
    while (true) {
      const pfs = pt.indexOf(P_O, pp);
      if (pfs === -1) break;
      const pne = pt.indexOf(">", pfs + P_O.length);
      if (pne === -1) break;
      const pn = pt.substring(pfs + P_O.length, pne);
      const ves = pne + 1;
      const vee = pt.indexOf(P_C, ves);
      if (vee === -1) break;
      args[pn] = pt.substring(ves, vee).trim();
      pp = vee + P_C.length;
    }
    toolCalls.push({
      id: `call_${fn}_${toolCalls.length + 1}`,
      type: "tool_call",
      name: fn,
      args,
    });
    pos = fe + F_C.length;
  }
  if (toolCalls.length === 0) return message;
  let clean = content;
  for (const tc of toolCalls) {
    const fnName = tc.name;
    const sm = F_O + fnName + ">";
    const em = F_C;
    const si = clean.indexOf(sm);
    if (si !== -1) {
      const ei = clean.indexOf(em, si);
      if (ei !== -1)
        clean = clean.substring(0, si) + clean.substring(ei + em.length);
    }
  }
  return new AIMessage({ content: clean.trim(), tool_calls: toolCalls });
}

// 在模型 invoke 方法外层包裹 XML 工具调用转换逻辑
function createModelWithXmlFix(model: ChatOpenAI): ChatOpenAI {
  const ob = model.bindTools.bind(model);
  (model as any).bindTools = (tools: any[]) => {
    const bm = ob(tools);
    const oi = bm.invoke.bind(bm);
    (bm as any).invoke = async (msgs: BaseMessage[], opts?: any) => {
      const r = await oi(msgs as any, opts);
      return convertXmlToolCalls(r as unknown as BaseMessage);
    };
    return bm;
  };
  return model;
}

// ============ 缓存 ============

// 按 prompt 内容分片缓存，避免不同 memory context 导致 prompt 错乱
const agentCache = new Map<string, Promise<AgentExecutor>>();
const MAX_CACHE_SIZE = 10;

// 创建或获取缓存的工具调用 Agent，相同 prompt 复用编译结果
export async function createToolAgent(
  systemPromptOverride?: string,
): Promise<AgentExecutor> {
  const prompt = systemPromptOverride || TOOL_CALLING_PROMPT;

  // 缓存命中：相同 prompt 直接返回
  const cached = agentCache.get(prompt);
  if (cached) return cached;

  // 缓存淘汰：超过上限时清 oldest entry
  if (agentCache.size >= MAX_CACHE_SIZE) {
    const firstKey = agentCache.keys().next().value!;
    agentCache.delete(firstKey);
  }

  const promise = buildToolAgent(prompt);
  agentCache.set(prompt, promise);
  return promise;
}

// 清空 Agent 缓存，下次调用将重新编译
export function invalidateToolAgentCache(): void {
  agentCache.clear();
}

// ============ 部分结果汇总 ============

const MAX_SYNTHESIS_INPUT_CHARS = 12_000;

/**
 * 使用 LLM 将多轮工具调用的原始结果汇总为结构化部分答案
 */
// 执行 synthesizePartialAnswer 对应的业务逻辑
async function synthesizePartialAnswer(
  userQuestion: string,
  observations: Array<{ index: number; toolName: string; observation: string }>,
): Promise<string> {
  // 先对每条工具观察结果做脱敏，防止原始数据（含 token、路径、密钥等）泄露给 synthesis LLM
  const safeObservations = observations.map((item) => ({
    ...item,
    observation: redactTextContent(item.observation),
  }));

  // 拼接所有观察结果，超长时截断
  const observationsBlock = safeObservations
    .map(
      (item) =>
        `[调用 ${item.index}] 工具: ${item.toolName}\n${item.observation}`,
    )
    .join("\n\n---\n\n");

  const truncatedBlock =
    observationsBlock.length > MAX_SYNTHESIS_INPUT_CHARS
      ? observationsBlock.slice(0, MAX_SYNTHESIS_INPUT_CHARS) +
        "\n\n...（以上为部分结果，因数据量大已被截断）"
      : observationsBlock;

  const synthesisPrompt = `你是一个数据整理助手。用户提出了一个问题，但 AI 助手在完成全部工具调用之前就耗尽了迭代次数限制。你无法获取更多数据。

## 数据安全规则
以下数据已做过脱敏处理（标记为 [REDACTED] / [INTERNAL_PATH] 等）。你在输出时也必须：
- 保留这些占位符，不得尝试还原
- 如果数据中有 [REDACTED] 标记，在输出中说明该信息因安全策略已被隐藏
- 不要暴露任何内部系统路径、API 密钥、密码、Token 等敏感信息

## 用户原始问题
${userQuestion || "（用户问题未记录）"}

## 已收集到的工具返回数据（已脱敏）
${truncatedBlock}

## 任务
请基于以上已收集的数据，尽可能为用户提供一个结构化的部分答案：

1. **只使用上述数据**，不要编造任何未出现在数据中的具体内容（如物品名称、掉落率、出处等）
2. 如果数据不足，**明确告知用户哪些信息缺失**，以及缺失的原因
3. 以清晰的格式（如表格、列表、分节）呈现已收集到的信息
4. 如果是掉落表类查询，用表格形式列出：物品名称、类型、出处怪物、备注
5. 结尾用一句话说明：由于信息量过大或迭代限制，以上是当前已收集到的部分结果
6. 如果数据完全不相关，直接告知用户未找到有效信息，并建议调整搜索策略

## 输出要求
- 不编造
- 不推测
- 不还原任何 [REDACTED] / [INTERNAL_PATH] 标记
- 结构清晰
- 诚实说明局限`;

  try {
    const synthesisModel = new ChatOpenAI({
      modelName: process.env.OPENAI_MODEL,
      timeout: 15_000,
      maxRetries: 0,
      configuration: {
        baseURL: process.env.OPENAI_BASE_URL,
        apiKey: process.env.OPENAI_API_KEY,
      },
    });

    const response = await synthesisModel.invoke([
      {
        role: "system",
        content: "你是一个数据整理助手，只基于给定的工具返回数据做结构化汇总，绝不编造。注意：输入数据中可能包含 [REDACTED] 等脱敏标记，你必须在输出中保留这些标记或说明信息已被隐藏，绝对不能还原敏感内容。",
      },
      { role: "user", content: synthesisPrompt },
    ]);

    let content = typeof response.content === "string" ? response.content : "";
    if (content.trim().length > 0) {
      // 对 synthesis 输出再做一次脱敏，双重保险
      content = redactTextContent(content);
      return `（以下为在迭代限制内收集到的部分结果）\n\n${content}`;
    }
  } catch (err) {
    console.warn("Partial answer synthesis failed:", err);
  }

  // LLM 汇总失败，回退到原始数据拼接（同样脱敏）
  const fallback = safeObservations
    .map(
      (item) =>
        `[调用 ${item.index}] 工具: ${item.toolName}\n${redactTextContent(item.observation).slice(0, 2000)}`,
    )
    .join("\n\n");

  return `由于内部处理异常，以下是我在迭代限制内收集到的原始数据：\n\n${redactTextContent(fallback).slice(0, 10_000)}`;
}

// 创建或注册 buildToolAgent 所需的数据
async function buildToolAgent(
  systemPromptOverride?: string,
): Promise<AgentExecutor> {
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
  const systemPrompt = systemPromptOverride || TOOL_CALLING_PROMPT;
  const dynamicPrompt = ChatPromptTemplate.fromMessages([
    ["system", systemPrompt],
    new MessagesPlaceholder({ variableName: "memory_context", optional: true }),
    new MessagesPlaceholder("chat_history"),
    ["human", "{input}"],
    new MessagesPlaceholder("agent_scratchpad"),
  ]);

  // 将每个工具包装为走 invokeTool 管线的版本，确保审计/预算/权限生效
  const wrappedTools = tools.map((tool) => {
    const descriptor = toolDescriptors[tool.name];
    const schema = toolSchemas[tool.name];
    if (descriptor) {
      return wrapToolWithRuntime(tool, descriptor, schema as any);
    }
    return tool;
  });

  const agent = await createOpenAIToolsAgent({
    llm: model as any,
    tools: wrappedTools as any,
    prompt: dynamicPrompt,
    // XML compatibility is applied in the bound model's invoke path. Keeping
    // planning non-streaming also avoids assembling partial XML fragments.
    streamRunnable: false,
  });

  // Runnable agents only support LangChain's default "force" stop, whose
  // output leaks the internal "Agent stopped due to max iterations." text to
  // users. When a pathological loop reaches the safety limit, synthesize a
  // structured partial answer from all collected tool observations.
  const userInputRef = { value: "" };

  const executor = new AgentExecutor({
    agent: agent as any,
    tools: wrappedTools as any,
    verbose: false,
    handleParsingErrors: true,
    maxIterations: MAX_AGENT_ITERATIONS,
  });

  // 拦截 invoke，在每次请求前记录用户原始输入
  const originalInvoke = (executor as any).invoke.bind(executor);
  (executor as any).invoke = async (
    input: Record<string, unknown>,
    ...rest: unknown[]
  ) => {
    userInputRef.value =
      typeof input?.input === "string" ? input.input : "";
    return originalInvoke(input, ...rest);
  };

  (executor.agent as any).returnStoppedResponse = async (
    _method: string,
    steps: AgentStep[],
  ) => {
    const userQuestion = userInputRef.value;

    // 从所有步骤中提取工具调用记录和观察结果
    const allObservations = steps
      .map((step, idx) => {
        const toolName = step.action?.tool ?? "unknown";
        const observation = step.observation;
        const obsText =
          typeof observation === "string"
            ? observation
            : JSON.stringify(observation, null, 2);
        return {
          index: idx + 1,
          toolName,
          observation: obsText,
        };
      })
      .filter((item) => item.observation.trim().length > 0);

    if (allObservations.length === 0) {
      return {
        returnValues: {
          output:
            "我尝试了多次工具调用来回答你的问题，但在收集到有效信息之前就耗尽了迭代次数。请尝试将问题拆分为更小的部分，或者更换关键词重新提问。",
        },
        log: "",
      };
    }

    // 用 LLM 对已收集的所有观察结果做结构化汇总
    const partialAnswer = await synthesizePartialAnswer(
      userQuestion,
      allObservations,
    );

    return {
      returnValues: {
        output: partialAnswer,
      },
      log: "",
    };
  };

  return executor;
}
