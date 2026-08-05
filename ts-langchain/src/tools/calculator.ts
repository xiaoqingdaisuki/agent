/**
 * Safe Math Calculator — 手写递归下降解析器替代 Function()/eval()
 *
 * 支持: +, -, *, /, %, **, 括号, 一元负号
 * 拒绝: 任意代码执行、函数调用、属性访问
 */

import { DynamicStructuredTool } from "langchain/tools";
import { z } from "zod";

import type { ToolDescriptor } from "./contracts.js";

// ============ 安全表达式解析器 ============

class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParseError";
  }
}

interface Token {
  type: "NUM" | "OP" | "LPAREN" | "RPAREN";
  value?: string;
  numValue?: number;
}

function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];

  // 先替换 ^ 为 **
  const normalized = expr.replace(/\^/g, "**");
  const allowed = new Set("0123456789+-*/.()% \t\n");

  // 字符白名单检查
  for (const ch of normalized) {
    if (!allowed.has(ch)) {
      throw new ParseError(`非法字符: '${ch}'`);
    }
  }

  // 拒绝字母
  if (/[a-zA-Z_]/.test(normalized)) {
    throw new ParseError("表达式包含字母，仅支持纯数字和运算符");
  }

  // ** 必须在 * 之前匹配（正则从左到右尝试）
  const regex = /\s*(\d+(?:\.\d+)?)|(\*\*)|([+\-*/%])|(\()|(\))\s*/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(normalized)) !== null) {
    if (match[1] !== undefined) {
      tokens.push({ type: "NUM", numValue: parseFloat(match[1]) });
    } else if (match[2] !== undefined) {
      tokens.push({ type: "OP", value: "**" });
    } else if (match[3] !== undefined) {
      tokens.push({ type: "OP", value: match[3] });
    } else if (match[4] !== undefined) {
      tokens.push({ type: "LPAREN" });
    } else if (match[5] !== undefined) {
      tokens.push({ type: "RPAREN" });
    }
  }

  return tokens;
}

function parseExpr(
  tokens: Token[],
  pos: number,
): { value: number; pos: number } {
  let { value, pos: p } = parseTerm(tokens, pos);

  while (
    p < tokens.length &&
    tokens[p].type === "OP" &&
    (tokens[p].value === "+" || tokens[p].value === "-")
  ) {
    const op = tokens[p].value!;
    p++;
    const right = parseTerm(tokens, p);
    p = right.pos;
    value = op === "+" ? value + right.value : value - right.value;
  }

  return { value, pos: p };
}

function parseTerm(
  tokens: Token[],
  pos: number,
): { value: number; pos: number } {
  let { value, pos: p } = parseFactor(tokens, pos);

  while (
    p < tokens.length &&
    tokens[p].type === "OP" &&
    ["*", "/", "%"].includes(tokens[p].value!)
  ) {
    const op = tokens[p].value!;
    p++;
    const right = parseFactor(tokens, p);
    p = right.pos;

    switch (op) {
      case "*":
        value = value * right.value;
        break;
      case "/":
        if (right.value === 0) throw new ParseError("除零错误");
        value = value / right.value;
        break;
      case "%":
        if (right.value === 0) throw new ParseError("取模除零");
        value = value % right.value;
        break;
    }
  }

  return { value, pos: p };
}

function parseFactor(
  tokens: Token[],
  pos: number,
): { value: number; pos: number } {
  // 一元运算符
  if (
    pos < tokens.length &&
    tokens[pos].type === "OP" &&
    (tokens[pos].value === "+" || tokens[pos].value === "-")
  ) {
    const op = tokens[pos].value!;
    pos++;
    const result = parseFactor(tokens, pos);
    return {
      value: op === "+" ? result.value : -result.value,
      pos: result.pos,
    };
  }

  let result = parsePrimary(tokens, pos);

  // 幂运算（**）— 右结合
  while (
    result.pos < tokens.length &&
    tokens[result.pos].type === "OP" &&
    tokens[result.pos].value === "**"
  ) {
    result.pos++;
    const exponent = parseFactor(tokens, result.pos);
    result.pos = exponent.pos;
    result.value = Math.pow(result.value, exponent.value);
  }

  return result;
}

function parsePrimary(
  tokens: Token[],
  pos: number,
): { value: number; pos: number } {
  if (pos >= tokens.length) {
    throw new ParseError("表达式不完整");
  }

  const token = tokens[pos];

  if (token.type === "NUM") {
    return { value: token.numValue!, pos: pos + 1 };
  }

  if (token.type === "LPAREN") {
    const result = parseExpr(tokens, pos + 1);
    if (result.pos >= tokens.length || tokens[result.pos].type !== "RPAREN") {
      throw new ParseError("缺少右括号 ')'");
    }
    return { value: result.value, pos: result.pos + 1 };
  }

  throw new ParseError(`意外的 token: ${JSON.stringify(token)}`);
}

// 安全计算数学表达式（四则运算、幂运算、括号）
export function safeCalculate(expression: string): number {
  const cleaned = expression.trim();
  if (!cleaned) throw new ParseError("空表达式");

  // 括号匹配检查
  let depth = 0;
  for (const ch of cleaned) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (depth < 0) throw new ParseError("括号不匹配");
  }
  if (depth !== 0) throw new ParseError("括号不匹配");

  const tokens = tokenize(cleaned);
  if (tokens.length === 0) throw new ParseError("空表达式");

  const result = parseExpr(tokens, 0).value;

  if (!Number.isFinite(result)) {
    throw new ParseError("计算结果不是有效数字");
  }

  return result;
}

// ============ LangChain Tool ============

export const calculatorInputSchema = z.object({
  expression: z.string().describe("数学表达式，如 '2 + 2' 或 '(10 + 5) * 3'"),
});

export const calculatorDescriptor: ToolDescriptor = {
  name: "math.calculate",
  version: "1.0.0",
  title: "数学计算",
  description:
    "安全计算数学表达式。支持四则运算、幂运算（**）、括号和取模（%）。只能做纯数学计算，不能执行代码或调用函数。",
  category: "COMPUTE",
  risk_level: "R0",
  side_effect: "none",
  timeout_ms: 5000,
  owner: "tools",
  tags: ["math", "compute"],
  input_schema: calculatorInputSchema,
};

export const calculatorTool: DynamicStructuredTool = new DynamicStructuredTool({
  name: "calculator",
  description:
    "安全计算数学表达式。支持四则运算、幂运算（**）、括号和取模（%）。当用户需要进行数学计算时使用此工具。",
  schema: calculatorInputSchema,
  func: async ({ expression }) => {
    try {
      const result = safeCalculate(expression);
      const formatted = Number.isInteger(result)
        ? String(result)
        : String(parseFloat(result.toFixed(10)));
      return `计算结果：${formatted}`;
    } catch (error) {
      return `表达式错误：${error instanceof Error ? error.message : "未知错误"}`;
    }
  },
});
