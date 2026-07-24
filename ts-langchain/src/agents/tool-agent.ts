import { ChatOpenAI } from "@langchain/openai";
import { createOpenAIToolsAgent } from "langchain/agents";
import { AgentExecutor } from "langchain/agents";
import { ChatPromptTemplate, MessagesPlaceholder } from "@langchain/core/prompts";
import { AIMessage, BaseMessage } from "@langchain/core/messages";
import { TOOL_CALLING_PROMPT } from "../prompts/system.js";
import { tools } from "../tools/index.js";

function convertXmlToolCalls(message: BaseMessage): BaseMessage {
  const content = typeof message.content === "string" ? message.content : "";
  const F_O = "<func" + "tion=";
  const F_C = "</func" + "tion>";
  const P_O = "<para" + "meter=";
  const P_C = "</para" + "meter=";
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
      id: "call_" + fn + "_001",
      type: "function",
      function: { name: fn, arguments: JSON.stringify(args) },
    });
    pos = fe + F_C.length;
  }
  if (toolCalls.length === 0) return message;
  let clean = content;
  for (const tc of toolCalls) {
    const fnName = (tc as any).function?.name ?? tc.name;
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
      const r = await oi(msgs, opts);
      return convertXmlToolCalls(r);
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
    new MessagesPlaceholder("chat_history"),
    ["human", "{input}"],
    new MessagesPlaceholder("agent_scratchpad"),
  ]);
  const agent = await createOpenAIToolsAgent({
    llm: model as any,
    tools: tools as any,
    prompt: dynamicPrompt,
  });
  return new AgentExecutor({
    agent: agent as any,
    tools: tools as any,
    verbose: false,
    handleParsingErrors: true,
    maxIterations: 3,  // 3 轮 = 1 次工具调用 + 最终回答，或 2 次工具调用 + 最终回答
  });
}
