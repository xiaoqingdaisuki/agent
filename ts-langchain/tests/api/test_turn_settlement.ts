/** 验证 api/test_turn_settlement 对应模块的行为与边界条件 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { terminateStreamTurn } from "../../src/api/stream-coordinator.js";
import { TurnService } from "../../src/services/index.js";
import { runWithRequestRuntime } from "../../src/runtime.js";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("Turn terminal persistence", () => {
  it("retains retry work without claiming failed persistence succeeded", async () => {
    vi.useFakeTimers();
    const terminate = vi.spyOn(TurnService, "terminate").mockRejectedValueOnce(new Error("gateway unavailable")).mockResolvedValue({} as any);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const background: Promise<unknown>[] = [];
    const settled = await runWithRequestRuntime({ waitUntil: (task) => { background.push(task); } },
      () => terminateStreamTurn("turn", "user", false, "MODEL_RESPONSE_INVALID"));
    expect(settled).toBe(false);
    expect(background).toHaveLength(1);
    await vi.runAllTimersAsync();
    await Promise.all(background);
    expect(terminate).toHaveBeenCalledTimes(2);
    expect(terminate).toHaveBeenLastCalledWith("turn", "user", false, "MODEL_RESPONSE_INVALID");
  });
});
