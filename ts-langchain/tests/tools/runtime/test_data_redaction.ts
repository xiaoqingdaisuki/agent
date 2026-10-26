/** 验证 tools/runtime/test_data_redaction 对应模块的行为与边界条件 */

import { describe, expect, it } from "vitest";
import { sanitizeResult } from "../../../src/tools/runtime/executor.js";
import { redactTextContent } from "../../../src/tools/runtime/data-redaction.js";

const JWT = [
  Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"),
  Buffer.from(JSON.stringify({ sub: "demo-user" })).toString("base64url"),
  "demo_signature",
].join(".");

describe("tool result content redaction", () => {
  it.each(["password", "passwd", "pwd", "pass"])("redacts the value of %s", (name) => {
    expect(redactTextContent(`${name}='demo_password_123'`)).toBe(`${name}=[REDACTED]`);
  });

  it("redacts complete Authorization headers", () => {
    expect(redactTextContent("Authorization: Basic ZHVtbXk6cGFzcw==\nstatus=200"))
      .toBe("Authorization: [REDACTED]\nstatus=200");
    expect(redactTextContent("Authorization: Bearer demo_access_token"))
      .toBe("Authorization: [REDACTED]");
  });

  it("preserves public links, versions and IPv4 addresses", () => {
    const text = "https://en.wikipedia.org/wiki/Agent; https://docs.python.org/3/; v1.2.3; 8.8.8.8";
    expect(redactTextContent(text)).toBe(text);
  });

  it("redacts JWTs and sensitive values throughout runtime results", () => {
    expect(sanitizeResult({ link: "https://en.wikipedia.org", nested: [JWT, "pwd=demo_password_123"] }))
      .toEqual({ link: "https://en.wikipedia.org", nested: ["[REDACTED]", "pwd=[REDACTED]"] });
  });
});
