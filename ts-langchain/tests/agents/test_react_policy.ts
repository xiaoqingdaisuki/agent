import { describe, expect, it } from "vitest";
import { createDefaultReActLimits, ReActRunTracker } from "../../src/agents/react-policy.js";

describe("declarative ReAct policy", () => {
  it("records framework-driven tool observations without owning an execution loop", () => {
    const tracker = new ReActRunTracker(createDefaultReActLimits());

    expect(tracker.beginModelCall()).toBe(false);
    const attempt = tracker.beforeTool("weather.current", { city: "Shanghai" });
    expect(attempt.allowed).toBe(true);
    tracker.recordTool("call-weather", "weather.current", attempt.signature, Date.now(), '{"temperature":25}');
    expect(tracker.beginModelCall()).toBe(false);
    tracker.complete("上海现在 25°C。");

    expect(tracker.summary()).toMatchObject({
      state: "COMPLETED",
      stop_reason: "ANSWER_COMPLETE",
      react_steps: 2,
      tool_calls: 1,
      tool_errors: 0,
    });
    expect(tracker.summary().observations[0]).toMatchObject({ status: "success", data: { temperature: 25 } });
  });

  it("stops a third identical failed tool attempt after the shared retry budget", () => {
    const tracker = new ReActRunTracker(createDefaultReActLimits());
    const first = tracker.beforeTool("weather.current", { city: "Shanghai" });
    tracker.recordTool("call-1", "weather.current", first.signature, Date.now(), null, new Error("unavailable"));
    const second = tracker.beforeTool("weather.current", { city: "Shanghai" });
    tracker.recordTool("call-2", "weather.current", second.signature, Date.now(), null, new Error("unavailable"));

    expect(tracker.beforeTool("weather.current", { city: "Shanghai" }).allowed).toBe(false);
    expect(tracker.summary()).toMatchObject({
      state: "TOOL_ERROR",
      stop_reason: "TOOL_FAILURE",
      reason_code: "TOOL_RETRY_EXHAUSTED",
      tool_calls: 2,
      tool_errors: 2,
    });
  });
});
