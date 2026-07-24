import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AIMessage } from "@langchain/core/messages";

import {
  MAX_AGENT_ITERATIONS,
  convertXmlToolCalls,
  createToolAgent,
  invalidateToolAgentCache,
} from "../../src/agents/tool-agent.js";

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

  it("reuses agents and never exposes LangChain's max-iteration message", async () => {
    const first = await createToolAgent();
    const second = await createToolAgent();

    expect(second).toBe(first);
    expect(first.maxIterations).toBe(MAX_AGENT_ITERATIONS);

    const stopped = await (first.agent as any).returnStoppedResponse("force", [], {});
    expect(stopped.returnValues.output).not.toContain(
      "Agent stopped due to max iterations.",
    );
  });
});
