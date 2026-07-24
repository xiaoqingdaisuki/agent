import { describe, expect, it } from "vitest";

import { isSafeUrl } from "../../src/tools/web-read.js";

describe("web.read SSRF protection", () => {
  it("rejects private, link-local, and reserved IPs", () => {
    expect(isSafeUrl("http://127.0.0.1").safe).toBe(false);
    expect(isSafeUrl("http://169.254.169.254").safe).toBe(false);
    expect(isSafeUrl("http://224.0.0.1").safe).toBe(false);
  });

  it("rejects URLs containing credentials", () => {
    const result = isSafeUrl("https://user:password@example.com");
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("用户名或密码");
  });
});
