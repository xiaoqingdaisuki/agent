import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AIMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { createAgent } from "langchain";
import { z } from "zod";

import {
  MAX_AGENT_ITERATIONS,
  convertXmlToolCalls,
  isDirectChatMessage,
  createToolAgent,
  invalidateToolAgentCache,
  createReActPolicyMiddleware,
} from "../../src/agents/tool-agent.js";
import {
  createDefaultReActLimits,
  ReActRunTracker,
  runWithReActTracker,
} from "../../src/agents/react-policy.js";

describe("tool agent", () => {
  const originalApiKey = process.env.OPENAI_API_KEY;

  beforeAll(() => {
    process.env.OPENAI_API_KEY = "test-key";
  });

  afterAll(() => {
    if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalApiKey;
  });

  afterEach(() => invalidateToolAgentCache());

  it("converts XML tool parameters to LangChain tool calls", () => {
    const message = new AIMessage(
      "<function=get_weather><parameter=city>Beijing</parameter></function>",
    );

    const result = convertXmlToolCalls(message) as AIMessage;

    expect(result.content).toBe("");
    expect(result.tool_calls).toEqual([
      {
        id: "call_get_weather_1",
        type: "tool_call",
        name: "get_weather",
        args: { city: "Beijing" },
      },
    ]);
  });

  it("converts invoke/name XML tool calls returned by providers", () => {
    const message = new AIMessage(
      '<invoke name="memory_user_search">' +
        '<parameter name="query">\n用户身份个人信息\n</parameter>' +
        "</invoke>",
    );

    const result = convertXmlToolCalls(message);

    expect(result.content).toBe("");
    expect(result.tool_calls).toEqual([
      {
        id: "call_memory_user_search_1",
        type: "tool_call",
        name: "memory_user_search",
        args: { query: "用户身份个人信息" },
      },
    ]);
  });

  it("normalizes descriptor names in provider XML tool calls", () => {
    const result = convertXmlToolCalls(
      new AIMessage(
        '<invoke name="web.search"><parameter name="query">南山美食</parameter></invoke>',
      ),
    );

    expect(result.tool_calls).toEqual([
      {
        id: "call_web_search_1",
        type: "tool_call",
        name: "web_search",
        args: { query: "南山美食" },
      },
    ]);
  });

  it("normalizes plain provider responses before middleware validation", () => {
    const result = convertXmlToolCalls({ content: "你好", type: "ai" });

    expect(AIMessage.isInstance(result)).toBe(true);
    expect(result.content).toBe("你好");
  });

  it("routes only clear casual messages through the no-tool fast path", () => {
    expect(isDirectChatMessage("你好")).toBe(true);
    expect(isDirectChatMessage("你是谁？")).toBe(true);
    expect(isDirectChatMessage("上海今天的天气")).toBe(false);
    expect(isDirectChatMessage("搜索今天的新闻")).toBe(false);
  });

  it("creates unique IDs for multiple XML tool calls", () => {
    const message = new AIMessage(
      "<function=get_weather><parameter=city>Beijing</parameter></function>" +
        "<function=get_weather><parameter=city>Shanghai</parameter></function>",
    );

    const result = convertXmlToolCalls(message) as AIMessage;

    expect(result.tool_calls?.map((call) => call.id)).toEqual([
      "call_get_weather_1",
      "call_get_weather_2",
    ]);
  });

  it("reuses declarative createAgent instances", async () => {
    const first = await createToolAgent();
    const second = await createToolAgent();

    expect(second).toBe(first);
    expect(first.maxIterations).toBe(MAX_AGENT_ITERATIONS);
    expect(typeof first.agent.streamEvents).toBe("function");
  });

  it("returns a runtime AIMessage through the ReAct middleware", async () => {
    const agent = createAgent({
      model: new FakeListChatModel({ responses: ["你好"] }),
      middleware: [createReActPolicyMiddleware()],
    });
    const tracker = new ReActRunTracker(createDefaultReActLimits());
    const result = await runWithReActTracker(tracker, () =>
      agent.invoke({ messages: [{ role: "user", content: "你好" }] }),
    );

    expect(AIMessage.isInstance(result.messages.at(-1))).toBe(true);
    expect(result.messages.at(-1)?.content).toBe("你好");
  });

  it("executes invoke/name XML calls through the real Agent loop", async () => {
    const calculator = tool(
      async () => "4",
      {
        name: "calculator",
        description: "Calculate an expression",
        schema: z.object({ expression: z.string() }),
      },
    );
    const model = new FakeListChatModel({
      responses: [
        '<invoke name="calculator"><parameter name="expression">2 + 2</parameter></invoke>',
        "4",
      ],
    });
    vi.spyOn(model, "bindTools").mockImplementation(() => model as any);
    const agent = createAgent({
      model,
      tools: [calculator],
      middleware: [createReActPolicyMiddleware()],
    });
    const tracker = new ReActRunTracker(createDefaultReActLimits());
    const result = await runWithReActTracker(tracker, () =>
      agent.invoke({ messages: [{ role: "user", content: "2 + 2?" }] }),
    );

    expect(result.messages.at(-1)?.content).toBe("4");
    expect(result.messages.some((message) => message.type === "tool")).toBe(true);
  });
});
