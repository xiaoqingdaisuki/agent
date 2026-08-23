import { beforeEach, describe, expect, it, vi } from "vitest";

const { createToolAgentMock, createDirectChatAgentMock, getFastPathAnswerMock } = vi.hoisted(() => ({
  createToolAgentMock: vi.fn(),
  createDirectChatAgentMock: vi.fn(),
  getFastPathAnswerMock: vi.fn(() => undefined),
}));

vi.mock("../../src/agents/tool-agent.js", () => ({
  createToolAgent: createToolAgentMock,
  createDirectChatAgent: createDirectChatAgentMock,
  getFastPathAnswer: getFastPathAnswerMock,
  isDirectChatMessage: (content: string) => content === "你好",
}));

import {
  AgentService,
  ConversationService,
  extractAgentOutputText,
} from "../../src/services/index.js";
import { AgentDeadlineError } from "../../src/agents/deadline.js";
import { MemoryService, ProfileService } from "../../src/profile/service.js";

describe("AgentService empty streams", () => {
  beforeEach(() => {
    createToolAgentMock.mockReset();
    createDirectChatAgentMock.mockReset();
  });

  it("does not expose a user message as the final agent answer", () => {
    expect(
      extractAgentOutputText({
        output: "__end__",
        messages: [{ role: "user", content: "calculate 12345 * 12" }],
      }),
    ).toBe("");
  });

  it("emits visible fallback text after a tool-only stream", async () => {
    createToolAgentMock.mockResolvedValue({
      streamEvents: async function* () {
        yield {
          event: "on_tool_start",
          name: "memory_user_search",
          run_id: "call-fallback",
        };
        yield {
          event: "on_tool_end",
          name: "memory_user_search",
          run_id: "call-fallback",
        };
      },
    });

    const conversation = await ConversationService.create("tool-only stream");
    const events = [];
    for await (const event of AgentService.chatStream(conversation.id, "who am I?")) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "agent", event: "agent.start" },
      {
        type: "tool",
        toolName: "memory_user_search",
        status: "started",
        callId: "call-fallback",
      },
      {
        type: "tool",
        toolName: "memory_user_search",
        status: "completed",
        callId: "call-fallback",
      },
      { type: "text", text: "抱歉，我没有理解您的问题。" },
    ]);
  });

  it("extracts the final AI answer when tool execution ends the graph", async () => {
    createToolAgentMock.mockResolvedValue({
      streamEvents: async function* () {
        yield {
          event: "on_tool_start",
          name: "web_search",
          run_id: "call-travel",
        };
        yield {
          event: "on_tool_end",
          name: "web_search",
          run_id: "call-travel",
        };
        yield {
          event: "on_chat_model_end",
          data: {
            output: {
              messages: [
                { type: "human", content: "深圳南山有什么好吃的和好玩的" },
                { type: "tool", content: "南山公园、海上世界" },
                { type: "ai", content: "可以安排南山公园和海上世界两天行程。" },
              ],
            },
          },
        };
      },
    });

    const conversation = await ConversationService.create("travel plan stream");
    const events = [];
    for await (const event of AgentService.chatStream(
      conversation.id,
      "深圳南山有什么好吃的和好玩的",
    )) {
      events.push(event);
    }

    expect(
      events
        .filter((event) => event.type === "text")
        .map((event) => event.text)
        .join(""),
    ).toBe("可以安排南山公园和海上世界两天行程。");
    expect(events).not.toContainEqual({
      type: "text",
      text: "抱歉，我没有理解您的问题。",
    });
  });

  it("replaces streamed whitespace with the final graph answer", async () => {
    createToolAgentMock.mockResolvedValue({
      streamEvents: async function* () {
        yield {
          event: "on_chain_end",
          data: {
            output: {
              messages: [
                { type: "tool", content: "计算结果：148140" },
                { type: "ai", content: "12345 × 12 = 148140" },
              ],
            },
          },
        };
        yield {
          event: "on_chat_model_stream",
          data: { chunk: { content: "\n\n\n" } },
        };
      },
    });

    const conversation = await ConversationService.create("whitespace before final answer");
    const events = [];
    for await (const event of AgentService.chatStream(conversation.id, "calculate")) {
      events.push(event);
    }

    expect(
      events
        .filter((event) => event.type === "text")
        .map((event) => event.text)
        .join(""),
    ).toBe("12345 × 12 = 148140");
  });

  it("falls back to invoke when a compatible gateway streams only whitespace", async () => {
    createToolAgentMock.mockResolvedValue({
      streamEvents: async function* () {
        yield {
          event: "on_chain_end",
          data: {
            output: {
              output:
                "\n<function=calculator><parameter=expression>12345*12</parameter></function>\n",
            },
          },
        };
        yield {
          event: "on_chat_model_stream",
          data: { chunk: { content: "\n\n\n" } },
        };
      },
      invoke: vi.fn().mockResolvedValue({
        output: "12345 × 12 = 148140",
        react: { state: "COMPLETED", stop_reason: "ANSWER_COMPLETE" },
      }),
    });

    const conversation = await ConversationService.create("gateway stream fallback");
    const events = [];
    for await (const event of AgentService.chatStream(conversation.id, "calculate")) {
      events.push(event);
    }

    expect(
      events
        .filter((event) => event.type === "text")
        .map((event) => event.text)
        .join(""),
    ).toBe("12345 × 12 = 148140");
  });

  it("treats whitespace left around an XML tool call as an empty answer", async () => {
    createToolAgentMock.mockResolvedValue({
      streamEvents: async function* () {
        yield {
          event: "on_chat_model_stream",
          data: {
            chunk: {
              content: '\n<invoke name="memory_user_search"></invoke>\n',
            },
          },
        };
      },
    });

    const conversation = await ConversationService.create("xml-only stream");
    const events = [];
    for await (const event of AgentService.chatStream(conversation.id, "who am I?")) {
      events.push(event);
    }

    expect(events).toContainEqual({
      type: "text",
      text: "抱歉，我没有理解您的问题。",
    });
    expect(events.filter((event) => event.type === "text")).toHaveLength(1);
  });

  it("returns visible text when a tool-enabled request times out before any answer", async () => {
    createToolAgentMock.mockResolvedValue({
      streamEvents: async function* () {
        throw new AgentDeadlineError(30_000);
      },
    });

    const conversation = await ConversationService.create("timeout stream");
    const events = [];
    for await (const event of AgentService.chatStream(conversation.id, "南山有什么好吃的？")) {
      events.push(event);
    }

    expect(events).toContainEqual({
      type: "text",
      text: "AI助手响应超时，请稍后重试。",
    });
  });

  it("does not wait for a slow memory gateway before streaming", async () => {
    createDirectChatAgentMock.mockResolvedValue({
      streamEvents: async function* () {
        yield {
          event: "on_chat_model_stream",
          data: { chunk: { content: "你好" } },
        };
      },
    });
    const profileSpy = vi
      .spyOn(ProfileService, "getOrCreate")
      .mockRejectedValue(new Error("gateway unavailable"));
    const memorySpy = vi
      .spyOn(MemoryService, "buildMemoryContext")
      .mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(""), 2_000)),
      );

    try {
      const conversation = await ConversationService.create("slow memory", "chat", "user-1");
      const events = await Promise.race([
        (async () => {
          const values = [];
          for await (const event of AgentService.chatStream(
            conversation.id,
            "你好",
            "user-1",
          )) {
            values.push(event);
          }
          return values;
        })(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("stream blocked by memory gateway")), 1_000),
        ),
      ]);
      expect(events).toContainEqual({ type: "text", text: "你好" });
    } finally {
      profileSpy.mockRestore();
      memorySpy.mockRestore();
    }
  });
});
