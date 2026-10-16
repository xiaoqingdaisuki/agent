import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AIMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { createAgent } from "langchain";
import { z } from "zod";

import {
  MAX_AGENT_ITERATIONS,
  MAX_STREAM_EVENT_BUFFER,
  convertXmlToolCalls,
  getFastPathAnswer,
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
  it.each([
    "你知道2026 APEC吗 能给我做个详细的介绍吗",
    "给我介绍点深圳特色美食具体到门店限定在福田区和南山区内以及在深圳的生活小技巧",
    "介绍2027年的展会", "介绍南山餐厅门店地址",
  ])("keeps search available for factual introductions: %s", (question) => {
    expect(isDirectChatMessage(question)).toBe(false);
  });

  it.each([
    "<dots_function_call><search><query>APEC</query></invoke></dots_function_call>",
    '<dots_function_call><invoke="search"><<arg_key>query</arg_key><arg_value>APEC</arg_value></invoke></dots_function_call>',
  ])("rejects malformed provider calls without executing them", (xml) => {
    expect(() => convertXmlToolCalls(new AIMessage(xml))).toThrow("无法解析的工具调用");
  });

  it("retries invalid protocol once and executes only the corrected call", async () => {
    const calculate = vi.fn(async () => "4");
    const calculator = tool(calculate, { name: "calculator", description: "Calculate", schema: z.object({ expression: z.string() }) });
    const model = new FakeListChatModel({ responses: [
      "<dots_function_call><search></invoke></dots_function_call>",
      '<invoke name="calculator"><parameter name="expression">2+2</parameter></invoke>', "4",
    ] });
    vi.spyOn(model, "bindTools").mockImplementation(() => model as any);
    const agent = createAgent({ model, tools: [calculator], middleware: [createReActPolicyMiddleware()] });
    const result = await agent.invoke({ messages: [{ role: "user", content: "计算2+2" }] });
    expect(result.messages.at(-1)?.content).toBe("4");
    expect(calculate).toHaveBeenCalledTimes(1);
  });
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

  it("converts dots function search calls and removes the provider envelope", () => {
    const result = convertXmlToolCalls(
      new AIMessage(
        "<dots_function_call><search>" +
          "<query>深圳南山区 2026年8月天气游玩</query>" +
          "<query>深圳南山区美食推荐</query>" +
          "</search></dots_function_call>",
      ),
    );

    expect(result.content).toBe("");
    expect(result.tool_calls).toEqual([
      {
        id: "call_web_search_1",
        type: "tool_call",
        name: "web_search",
        args: { query: "深圳南山区 2026年8月天气游玩" },
      },
      {
        id: "call_web_search_2",
        type: "tool_call",
        name: "web_search",
        args: { query: "深圳南山区美食推荐" },
      },
    ]);
  });

  it("normalizes plain provider responses before middleware validation", () => {
    const result = convertXmlToolCalls({ content: "你好", type: "ai" });

    expect(AIMessage.isInstance(result)).toBe(true);
    expect(result.content).toBe("你好");
  });

  it("prefers native tool calls when a provider also includes dots XML", () => {
    const result = convertXmlToolCalls(
      new AIMessage({
        content:
          "已准备查询。<dots_function_call><search>" +
          "<query>不应重复执行</query>" +
          "</search></dots_function_call>",
        tool_calls: [
          {
            id: "native-call-1",
            type: "tool_call",
            name: "web_search",
            args: { query: "原生调用" },
          },
        ],
      }),
    );

    expect(result.content).toBe("已准备查询。");
    expect(result.tool_calls).toEqual([
      {
        id: "native-call-1",
        type: "tool_call",
        name: "web_search",
        args: { query: "原生调用" },
      },
    ]);
  });

  it("routes ordinary answer styles directly while preserving tool intents", () => {
    expect(isDirectChatMessage("你好")).toBe(true);
    expect(isDirectChatMessage("你是谁？")).toBe(true);
    expect(isDirectChatMessage("请用三句话解释递归")).toBe(true);
    expect(isDirectChatMessage("请解释1990年的计算机发展历史")).toBe(true);
    expect(isDirectChatMessage("写一个发生在2020年的故事")).toBe(true);
    expect(isDirectChatMessage("解释内存地址的含义")).toBe(true);
    expect(isDirectChatMessage("写两句温和的欢迎语")).toBe(true);
    expect(isDirectChatMessage("写一个 Python 去重函数")).toBe(true);
    expect(isDirectChatMessage("请比较批处理响应和流式响应")).toBe(true);
    expect(isDirectChatMessage("上海今天的天气")).toBe(false);
    expect(isDirectChatMessage("搜索今天的新闻")).toBe(false);
    expect(isDirectChatMessage("请计算 12345 × 12")).toBe(false);
    expect(isDirectChatMessage("请告诉我现在的北京时间")).toBe(false);
    expect(isDirectChatMessage("读取这份文件中的第二段")).toBe(false);
    expect(isDirectChatMessage("你记得我的偏好吗")).toBe(false);
    expect(isDirectChatMessage("深圳南山有什么好吃的和好玩的")).toBe(false);
    expect(isDirectChatMessage("calculate 12345 * 12")).toBe(false);
    expect(isDirectChatMessage("who am I?")).toBe(false);
    expect(isDirectChatMessage("谁是图灵？")).toBe(false);
    expect(isDirectChatMessage("把巴黎时间 15:00 换成东京时间")).toBe(false);
    expect(isDirectChatMessage("总结我刚上传的 PDF")).toBe(false);
    expect(isDirectChatMessage("明天呢？")).toBe(false);
    expect(isDirectChatMessage("随便聊点什么")).toBe(false);
  });

  it("never returns a location-specific recommendation from the static fast path", () => {
    expect(getFastPathAnswer("北京有什么好吃的")).toBeUndefined();
    expect(getFastPathAnswer("深圳南山有什么好玩的")).toBeUndefined();
  });

  it("preserves additional requirements after a recursion question", () => {
    expect(getFastPathAnswer("什么是递归？")).toContain("调用自身");
    expect(getFastPathAnswer("请解释递归，并计算 12345 × 12")).toBeUndefined();
    expect(getFastPathAnswer("请用三句话解释递归")).toBeUndefined();
    expect(getFastPathAnswer("什么是递归，请用 Python 举例")).toBeUndefined();
  });

  it("deduplicates structured memory saves without dropping other calls", () => {
    const result = convertXmlToolCalls(new AIMessage({
      content: "",
      tool_calls: [
        { id: "save-1", name: "memory_user_save", args: { content: "我喜欢蓝色", category: "preference" } },
        { id: "save-2", name: "memory_user_save", args: { category: "preference", content: "我喜欢蓝色" } },
        { id: "list-1", name: "memory_user_list", args: {} },
      ],
    }));

    expect(result.tool_calls?.map((call) => call.id)).toEqual(["save-1", "list-1"]);
  });

  it("executes a repeated XML memory save once through the real Agent loop", async () => {
    const save = vi.fn(async () => "saved");
    const memorySave = tool(save, {
      name: "memory_user_save",
      description: "Save a user preference",
      schema: z.object({ content: z.string() }),
    });
    const xml = '<invoke name="memory_user_save"><parameter name="content">我喜欢蓝色</parameter></invoke>';
    const model = new FakeListChatModel({ responses: [xml + xml, "已记住"] });
    vi.spyOn(model, "bindTools").mockImplementation(() => model as any);
    const agent = createAgent({ model, tools: [memorySave], middleware: [createReActPolicyMiddleware()] });
    const tracker = new ReActRunTracker(createDefaultReActLimits());

    const result = await runWithReActTracker(tracker, () =>
      agent.invoke({ messages: [{ role: "user", content: "记住我喜欢蓝色" }] }),
    );

    expect(save).toHaveBeenCalledOnce();
    expect(result.messages.at(-1)?.content).toBe("已记住");
    expect(tracker.summary().tool_calls).toBe(1);
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

  it("applies backpressure instead of buffering an unbounded model event stream", async () => {
    const wrapped = await createToolAgent();
    let produced = 0;
    const total = MAX_STREAM_EVENT_BUFFER * 2;
    vi.spyOn(wrapped.agent, "streamEvents").mockImplementation(async function* () {
      for (let index = 0; index < total; index += 1) {
        produced += 1;
        yield { event: "on_chat_model_stream", data: { index } } as any;
      }
    } as any);

    const iterator = wrapped.streamEvents({ input: "slow consumer" });
    await iterator.next();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    // 队列容量之外允许一个已交付和一个等待入队的在途事件。
    expect(produced).toBeLessThanOrEqual(MAX_STREAM_EVENT_BUFFER + 2);
    for await (const _event of iterator) {
      // 消费完事件以释放异步泵和测试资源。
    }
    expect(produced).toBe(total);
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

  it("stops an identical error Observation after one retry in the real Agent loop", async () => {
    const fail = vi.fn(async () => JSON.stringify({ status: "error", data: null, error: { code: "INTERNAL_ERROR", message: "offline" } }));
    const failingTool = tool(fail, {
      name: "failing_tool",
      description: "Return a recoverable error",
      schema: z.object({ query: z.string() }),
    });
    const xml = '<invoke name="failing_tool"><parameter name="query">same</parameter></invoke>';
    const model = new FakeListChatModel({ responses: [xml, xml, xml, "partial answer"] });
    vi.spyOn(model, "bindTools").mockImplementation(() => model as any);
    const agent = createAgent({ model, tools: [failingTool], middleware: [createReActPolicyMiddleware()] });
    const tracker = new ReActRunTracker(createDefaultReActLimits());

    const result = await runWithReActTracker(tracker, () =>
      agent.invoke({ messages: [{ role: "user", content: "question" }] }),
    );

    expect(fail).toHaveBeenCalledTimes(2);
    expect(result.messages.at(-1)?.content).toBe("partial answer");
    expect(tracker.summary()).toMatchObject({
      state: "TOOL_ERROR", stop_reason: "TOOL_FAILURE", reason_code: "TOOL_RETRY_EXHAUSTED",
      tool_calls: 2, tool_errors: 2, model_calls: 4,
    });
  });
});
