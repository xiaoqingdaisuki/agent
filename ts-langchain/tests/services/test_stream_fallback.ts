import { beforeEach, describe, expect, it, vi } from "vitest";

const { createToolAgentMock } = vi.hoisted(() => ({
  createToolAgentMock: vi.fn(),
}));

vi.mock("../../src/agents/tool-agent.js", () => ({
  createToolAgent: createToolAgentMock,
}));

import { AgentService, ConversationService } from "../../src/services/index.js";
import { AgentDeadlineError } from "../../src/agents/deadline.js";

describe("AgentService empty streams", () => {
  beforeEach(() => createToolAgentMock.mockReset());

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
});
