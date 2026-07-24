import { describe, it, expect } from "vitest";
import { safeCalculate } from "../../src/tools/calculator.js";

describe("Safe Calculator", () => {
  it("adds two numbers", () => {
    expect(safeCalculate("2 + 3")).toBe(5);
  });

  it("subtracts", () => {
    expect(safeCalculate("10 - 4")).toBe(6);
  });

  it("multiplies", () => {
    expect(safeCalculate("3 * 7")).toBe(21);
  });

  it("divides", () => {
    expect(safeCalculate("10 / 4")).toBe(2.5);
  });

  it("modulo", () => {
    expect(safeCalculate("10 % 3")).toBe(1);
  });

  it("power", () => {
    expect(safeCalculate("2 ** 10")).toBe(1024);
  });

  it("caret as power alias", () => {
    expect(safeCalculate("2 ^ 10")).toBe(1024);
  });

  it("parentheses", () => {
    expect(safeCalculate("(2 + 3) * 4")).toBe(20);
  });

  it("nested parentheses", () => {
    expect(safeCalculate("((1 + 2) * 3) + 4")).toBe(13);
  });

  it("unary minus", () => {
    expect(safeCalculate("-5 + 3")).toBe(-2);
  });

  it("unary plus", () => {
    expect(safeCalculate("+5 + 3")).toBe(8);
  });

  it("float numbers", () => {
    expect(safeCalculate("3.14 + 2.86")).toBeCloseTo(6.0);
  });

  it("spaces ignored", () => {
    expect(safeCalculate(" 2 + 3 ")).toBe(5);
  });

  it("complex expression", () => {
    // (10 + 5) * 3 - 20 / 4 = 45 - 5 = 40
    expect(safeCalculate("(10 + 5) * 3 - 20 / 4")).toBe(40);
  });

  it("throws on division by zero", () => {
    expect(() => safeCalculate("1 / 0")).toThrow();
  });

  it("throws on mismatched parens", () => {
    expect(() => safeCalculate("(1 + 2")).toThrow();
  });

  it("throws on letters", () => {
    expect(() => safeCalculate("abc")).toThrow();
  });

  it("throws on empty string", () => {
    expect(() => safeCalculate("")).toThrow();
  });

  it("throws on function call", () => {
    expect(() => safeCalculate("pow(2, 3)")).toThrow();
  });
});
