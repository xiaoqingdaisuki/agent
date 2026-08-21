import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AIMessage } from "@langchain/core/messages";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { createAgent } from "langchain";

import {
  MAX_AGENT_ITERATIONS,
  convertXmlToolCalls,
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

  it("normalizes plain provider responses before middleware validation", () => {
    const result = convertXmlToolCalls({ content: "你好", type: "ai" });

    expect(AIMessage.isInstance(result)).toBe(true);
    expect(result.content).toBe("你好");
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
});
