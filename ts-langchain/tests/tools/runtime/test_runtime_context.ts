import { describe, expect, it } from "vitest";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";

import type { ToolCallContext, ToolDescriptor } from "../../../src/tools/contracts.js";
import {
  budgetGuard,
  createToolCallScope,
  getToolCallContext,
  permissionCheck,
  runWithToolCallContext,
  wrapToolWithRuntime,
} from "../../../src/tools/runtime/executor.js";

function context(userId: string, roles: string[] = ["member"]): ToolCallContext {
  return {
    request_id: `request-${userId}`,
    trace_id: `trace-${userId}`,
    conversation_id: `conversation-${userId}`,
    tenant_id: "tenant",
    user_id: userId,
    actor_type: "user",
    roles,
  };
}

describe("per-request tool runtime", () => {
  it("preserves denial reasons and role order across permission cache hits", () => {
    const roles = ["viewer", "member"];
    const descriptor: ToolDescriptor = {
      name: "memory.user.save", version: "1.0.0", title: "save", description: "save",
      category: "MEMORY", risk_level: "R2", side_effect: "write", timeout_ms: 1000,
      required_permissions: ["memory.user.write"], input_schema: {},
    };
    const first = permissionCheck(context("denied-cache-user", roles), descriptor);
    const second = permissionCheck(context("denied-cache-user", roles), descriptor);

    expect(first).toEqual(second);
    expect(second.reason).toContain("PERMISSION_DENIED");
    expect(roles).toEqual(["viewer", "member"]);
  });

  it("isolates concurrent request contexts", async () => {
    const first = createToolCallScope(context("first"));
    const second = createToolCallScope(context("second"));
    const [firstUser, secondUser] = await Promise.all([
      first.run(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return getToolCallContext()?.user_id;
      }),
      second.run(async () => getToolCallContext()?.user_id),
    ]);
    expect(firstUser).toBe("first");
    expect(secondUser).toBe("second");
  });

  it("does not share exhausted budgets between requests", () => {
    const exhausted = createToolCallScope(context("one"));
    exhausted.run(() => {
      for (let index = 0; index < 8; index += 1) expect(budgetGuard()).toBeNull();
      expect(budgetGuard()?.error?.code).toBe("RATE_LIMITED");
    });
    createToolCallScope(context("two")).run(() => expect(budgetGuard()).toBeNull());
  });

  it("overrides model supplied memory ownership with request context", async () => {
    let executedUserId = "";
    const schema = z.object({ user_id: z.string(), content: z.string() });
    const rawTool = new DynamicStructuredTool({
      name: "memory.user.save",
      description: "test",
      schema,
      func: async ({ user_id }) => {
        executedUserId = user_id;
        return "ok";
      },
    });
    const descriptor: ToolDescriptor = {
      name: "memory.user.save", version: "1.0.0", title: "save", description: "save",
      category: "MEMORY", risk_level: "R2", side_effect: "write", timeout_ms: 1000,
      required_permissions: ["memory.user.write"], input_schema: {},
    };
    const wrapped = wrapToolWithRuntime(rawTool, descriptor, schema);
    await runWithToolCallContext(context("owner", ["admin"]), () =>
      wrapped.invoke({ user_id: "victim", content: "secret" }),
    );
    expect(executedUserId).toBe("owner");
  });

  it("deduplicates memory.user.save with same content within a request", async () => {
    const schema = z.object({ user_id: z.string(), content: z.string() });
    const rawTool = new DynamicStructuredTool({
      name: "memory_user_save",
      description: "save memory",
      schema,
      func: async () => "saved",
    });
    const descriptor: ToolDescriptor = {
      name: "memory_user_save", version: "1.0.0", title: "save", description: "save",
      category: "MEMORY", risk_level: "R2", side_effect: "write", timeout_ms: 1000,
      required_permissions: ["memory.user.write"], input_schema: {},
    };
    const wrapped = wrapToolWithRuntime(rawTool, descriptor, schema);
    const results = await runWithToolCallContext(context("u1", ["admin"]), async () => [
      await wrapped.invoke({ user_id: "u1", content: "same content" }),
      await wrapped.invoke({ user_id: "u1", content: "same content" }),
      await wrapped.invoke({ user_id: "u1", content: "different content" }),
    ]);
    expect(results[0]).toBe("saved");
    expect(results[1]).toContain("已存在");
    expect(results[2]).toBe("saved");
  });

  it("isolates memory dedup across different requests", async () => {
    const schema = z.object({ user_id: z.string(), content: z.string() });
    const rawTool = new DynamicStructuredTool({
      name: "memory_user_save",
      description: "save memory",
      schema,
      func: async () => "saved",
    });
    const descriptor: ToolDescriptor = {
      name: "memory_user_save", version: "1.0.0", title: "save", description: "save",
      category: "MEMORY", risk_level: "R2", side_effect: "write", timeout_ms: 1000,
      required_permissions: ["memory.user.write"], input_schema: {},
    };
    const wrapped = wrapToolWithRuntime(rawTool, descriptor, schema);
    const [r1, r2] = await Promise.all([
      runWithToolCallContext(context("user-a", ["admin"]), () =>
        wrapped.invoke({ user_id: "user-a", content: "shared content" }),
      ),
      runWithToolCallContext(context("user-b", ["admin"]), () =>
        wrapped.invoke({ user_id: "user-b", content: "shared content" }),
      ),
    ]);
    expect(r1).toBe("saved");
    expect(r2).toBe("saved");
  });
});
