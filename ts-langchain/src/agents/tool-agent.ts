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
    toolCalls.push({ name: fn, args, id: "call_" + fn + "_001" });
    pos = fe + F_C.length;
  }
  if (toolCalls.length === 0) return message;
  let clean = content;
  for (const tc of toolCalls) {
    const sm = F_O + tc.name + ">";
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

const prompt = ChatPromptTemplate.fromMessages([
  ["system", "{system_prompt}"],
  new MessagesPlaceholder("chat_history"),
  ["human", "{input}"],
  new MessagesPlaceholder("agent_scratchpad"),
]);

let toolAgent: Promise<AgentExecutor> | null = null;

export async function createToolAgent(systemPromptOverride?: string): Promise<AgentExecutor> {
  if (toolAgent && !systemPromptOverride) return toolAgent;
  toolAgent = buildToolAgent(systemPromptOverride);
  return toolAgent;
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
    maxIterations: 3,
  });
}
