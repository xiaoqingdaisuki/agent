import { ChatOpenAI } from "@langchain/openai";
import { createOpenAIToolsAgent } from "langchain/agents";
import { AgentExecutor } from "langchain/agents";
import { ChatPromptTemplate, MessagesPlaceholder } from "@langchain/core/prompts";
import { AIMessage, BaseMessage } from "@langchain/core/messages";
import type { AgentStep } from "@langchain/core/agents";
import { TOOL_CALLING_PROMPT } from "../prompts/system.js";
import { tools, toolDescriptors, toolSchemas } from "../tools/index.js";
import { wrapToolWithRuntime } from "../tools/runtime/executor.js";

// Eight tool rounds plus one final planning round, aligned with Python.
export const MAX_AGENT_ITERATIONS = 9;

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
      if (ei !== -1) clean = clean.substring(0, si) + clean.substring(ei + em.length);
    }
  }
  return new AIMessage({ content: clean.trim(), tool_calls: toolCalls });
}

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

export async function createToolAgent(systemPromptOverride?: string): Promise<AgentExecutor> {
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

export function invalidateToolAgentCache(): void {
  agentCache.clear();
}

async function buildToolAgent(systemPromptOverride?: string): Promise<AgentExecutor> {
  const rawModel = new ChatOpenAI({
    modelName: process.env.OPENAI_MODEL,
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
  // users. Return the most recent tool observation instead when a pathological
  // loop reaches the safety limit.
  const executor = new AgentExecutor({
    agent: agent as any,
    tools: wrappedTools as any,
    verbose: false,
    handleParsingErrors: true,
    maxIterations: MAX_AGENT_ITERATIONS,
  });

  (executor.agent as any).returnStoppedResponse = async (
    _method: string,
    steps: AgentStep[],
  ) => {
    const lastObservation = steps.at(-1)?.observation;
    const detail = typeof lastObservation === "string" && lastObservation.trim()
      ? ` Last tool result: ${lastObservation.slice(0, 2_000)}`
      : "";
    return {
      returnValues: {
        output: `I could not complete more tool calls within the safety limit.${detail}`,
      },
      log: "",
    };
  };

  return executor;
}
