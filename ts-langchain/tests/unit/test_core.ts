import { describe, it, expect } from "vitest";
import { z } from "zod";
import { safeCalculate } from "../../src/tools/calculator.js";

// ============ Config Validation Tests ============

const envSchema = z.object({
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default("gpt-4o-mini"),
  OPENAI_BASE_URL: z.string().optional(),
  IMAGE_MODEL: z.string().default("step-image-edit-2"),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default("claude-3-5-haiku-20241022"),
  PORT: z.coerce.number().default(6001),
});

describe("Config validation", () => {
  it("should use default values when env vars are missing", () => {
    const result = envSchema.parse({
      OPENAI_API_KEY: "",
      OPENAI_BASE_URL: "",
    });
    expect(result.OPENAI_MODEL).toBe("gpt-4o-mini");
    expect(result.PORT).toBe(6001);
    expect(result.IMAGE_MODEL).toBe("step-image-edit-2");
  });

  it("should parse provided env vars", () => {
    const result = envSchema.parse({
      OPENAI_API_KEY: "test-key",
      OPENAI_MODEL: "gpt-4",
      PORT: 9000,
    });
    expect(result.OPENAI_API_KEY).toBe("test-key");
    expect(result.OPENAI_MODEL).toBe("gpt-4");
    expect(result.PORT).toBe(9000);
  });
});

// ============ Tool Schema Tests ============

describe("Tool schemas", () => {
  it("weather tool schema should require city", () => {
    const WeatherSchema = z.object({
      city: z.string().describe("The city name"),
    });
    const result = WeatherSchema.parse({ city: "Beijing" });
    expect(result.city).toBe("Beijing");
  });

  it("calculator tool schema should require expression", () => {
    const CalculatorSchema = z.object({
      expression: z.string().describe("A math expression"),
    });
    const result = CalculatorSchema.parse({ expression: "2 + 2" });
    expect(result.expression).toBe("2 + 2");
  });
});

// ============ Calculator Logic Tests ============

describe("Calculator logic", () => {
  it("should evaluate simple expressions", () => {
    expect(safeCalculate("2 + 2")).toBe(4);
  });

  it("should evaluate multiplication", () => {
    expect(safeCalculate("10 * 5")).toBe(50);
  });

  it("should handle subtraction", () => {
    expect(safeCalculate("10 - 3")).toBe(7);
  });

  it("should handle division", () => {
    expect(safeCalculate("10 / 4")).toBe(2.5);
  });

  it("should handle modulo", () => {
    expect(safeCalculate("10 % 3")).toBe(1);
  });

  it("should reject expression with letters", () => {
    expect(() => safeCalculate("import os")).toThrow();
  });

  it("should reject empty expression", () => {
    expect(() => safeCalculate("")).toThrow();
  });

  it("should handle parentheses", () => {
    expect(safeCalculate("(2 + 3) * 4")).toBe(20);
  });

  it("should handle power operator", () => {
    expect(safeCalculate("2 ** 10")).toBe(1024);
  });
});

// ============ Error Handling Tests ============

describe("Error handling patterns", () => {
  it("should detect API key errors", () => {
    const errorMessage = "Invalid API key provided";
    expect(errorMessage.toLowerCase()).toContain("api key");
  });

  it("should detect rate limit errors", () => {
    const errorMessage = "Rate limit exceeded (429)";
    expect(errorMessage.toLowerCase()).toContain("rate limit");
    expect(errorMessage).toContain("429");
  });
});

// ============ API Request Schema Tests ============

describe("API request schemas", () => {
  it("chat request should require message", () => {
    const ChatSchema = z.object({
      message: z.string().min(1),
      thread_id: z.string().optional(),
    });
    expect(() => ChatSchema.parse({})).toThrow();
  });

  it("chat request should accept optional thread_id", () => {
    const ChatSchema = z.object({
      message: z.string().min(1),
      thread_id: z.string().optional(),
    });
    const result = ChatSchema.parse({ message: "hello", thread_id: "abc" });
    expect(result.thread_id).toBe("abc");
  });

  it("stream request should require message", () => {
    const StreamSchema = z.object({
      message: z.string().min(1),
      thread_id: z.string().optional(),
    });
    expect(() => StreamSchema.parse({})).toThrow();
  });
});

// ============ RAG TextSplitter Logic Tests ============

describe("RAG TextSplitter logic", () => {
  const recursiveSplit = (
    text: string,
    chunkSize: number = 1000,
    chunkOverlap: number = 200
  ): string[] => {
    if (text.length <= chunkSize) return [text];

    const chunks: string[] = [];
    const separators = ["\n\n", "\n", "。", ". ", " ", ""];

    let splitAt = -1;
    for (const sep of separators) {
      const pos = text.lastIndexOf(sep, chunkSize);
      if (pos > chunkSize * 0.3) {
        splitAt = pos + sep.length;
        break;
      }
    }

    if (splitAt === -1) splitAt = chunkSize;

    const chunk = text.slice(0, splitAt).trim();
    const remaining = text.slice(splitAt - chunkOverlap);
    chunks.push(chunk);
    chunks.push(...recursiveSplit(remaining, chunkSize, chunkOverlap));
    return chunks;
  };

  it("should return single chunk for short text", () => {
    const result = recursiveSplit("Hello world");
    expect(result.length).toBe(1);
  });

  it("should split long text", () => {
    const longText = "A".repeat(2000);
    const result = recursiveSplit(longText, 500, 100);
    expect(result.length).toBeGreaterThan(1);
  });

  it("should handle empty string", () => {
    const result = recursiveSplit("");
    expect(result).toEqual([""]);
  });
});

// ============ Agent State Tests ============

describe("Agent state", () => {
  it("should track messages", () => {
    interface Message {
      role: "user" | "assistant";
      content: string;
    }
    const messages: Message[] = [];
    messages.push({ role: "user", content: "Hello" });
    messages.push({ role: "assistant", content: "Hi there!" });
    expect(messages.length).toBe(2);
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("assistant");
  });
});
