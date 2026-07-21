import { DynamicStructuredTool } from "langchain/tools";
import { z } from "zod";

export const weatherTool = new DynamicStructuredTool({
  name: "get_weather",
  description: "Get the current weather for a city. Use this when the user asks about weather.",
  schema: z.object({
    city: z.string().describe("The city name, e.g. 'New York'"),
  }),
  func: async ({ city }) => {
    const conditions = ["sunny", "cloudy", "rainy", "snowy"];
    const temps = [65, 72, 80, 55, 90, 45];
    const condition = conditions[Math.floor(Math.random() * conditions.length)];
    const temp = temps[Math.floor(Math.random() * temps.length)];
    return `Weather in ${city}: ${temp}°F, ${condition}`;
  },
});

export const calculatorTool = new DynamicStructuredTool({
  name: "calculator",
  description: "Evaluate a math expression. Use this for calculations.",
  schema: z.object({
    expression: z.string().describe("A math expression, e.g. '2 + 2' or '10 * 5'"),
  }),
  func: async ({ expression }) => {
    try {
      const sanitized = expression.replace(/[^0-9+\-*/().%\s]/g, "");
      const result = Function(`"use strict"; return (${sanitized})`)();
      return `Result: ${result}`;
    } catch {
      return `Error: Cannot evaluate '${expression}'`;
    }
  },
});

export const tools = [weatherTool, calculatorTool];
