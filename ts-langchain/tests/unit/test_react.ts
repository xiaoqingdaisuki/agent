import { describe, expect, it } from "vitest";
import { AIMessage } from "@langchain/core/messages";
import { DynamicStructuredTool } from "langchain/tools";
import { z } from "zod";
import {
  createDefaultReActLimits,
  ReActAgentExecutor,
} from "../../src/agents/react.js";

class FakeModel {
  private readonly responses: AIMessage[];
  calls = 0;

  constructor(responses: AIMessage[]) {
    this.responses = [...responses];
  }

  bindTools(): this {
    return this;
  }

  async invoke(): Promise<AIMessage> {
    this.calls += 1;
    const response = this.responses.shift();
    if (!response) throw new Error("no fake response");
    return response;
  }
}

function createWeatherTool(shouldFail = false): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: "weather.current",
    description: "查询天气",
    schema: z.object({ city: z.string() }),
    func: async () => {
      if (shouldFail) throw new Error("weather unavailable");
      return JSON.stringify({ city: "Shanghai", temperature: 25 });
    },
  });
}

describe("ReAct executor", () => {
  it("reasons again after an Observation and returns a structured summary", async () => {
    const model = new FakeModel([
      new AIMessage({
        content: "",
        tool_calls: [
          { id: "call-weather", name: "weather.current", args: { city: "Shanghai" } },
        ],
      }),
      new AIMessage("上海现在 25°C。"),
    ]);
    const executor = new ReActAgentExecutor(
      model,
      [createWeatherTool()],
      "test prompt",
      createDefaultReActLimits({ maxTotalTimeMs: 10_000 }),
    );

    const result = await executor.invoke({ input: "上海天气怎么样？" });

    expect(result.output).toContain("25°C");
    expect(result.react.stop_reason).toBe("ANSWER_COMPLETE");
    expect(result.react.tool_calls).toBe(1);
    expect(result.react.observations[0].status).toBe("success");
  });

  it("retries the same failed call once and then stops", async () => {
    let callNumber = 0;
    const call = () =>
      new AIMessage({
        content: "",
        tool_calls: [
          { id: `call-weather-${++callNumber}`, name: "weather.current", args: { city: "Shanghai" } },
        ],
      });
    const model = new FakeModel([call(), call(), call()]);
    const executor = new ReActAgentExecutor(
      model,
      [createWeatherTool(true)],
      "test prompt",
      createDefaultReActLimits({ maxTotalTimeMs: 10_000 }),
    );

    const result = await executor.invoke({ input: "上海天气怎么样？" });

    expect(result.react.stop_reason).toBe("TOOL_FAILURE");
    expect(result.react.tool_calls).toBe(2);
    expect(result.react.tool_errors).toBe(2);
  });
});
