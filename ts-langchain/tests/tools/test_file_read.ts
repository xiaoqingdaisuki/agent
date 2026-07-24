import { describe, expect, it } from "vitest";

import { maskSensitive, resolveSafePath } from "../../src/tools/file-read.js";

describe("file.read security", () => {
  it("rejects absolute paths and traversal", () => {
    expect(resolveSafePath("C:\\Windows\\win.ini", "D:\\workspace").path).toBeNull();
    expect(resolveSafePath("../secret.txt", "D:\\workspace").path).toBeNull();
  });

  it("keeps relative paths inside the configured workspace", () => {
    const result = resolveSafePath("src/main.ts", "D:\\workspace");
    expect(result.error).toBeUndefined();
    expect(result.path?.toLowerCase()).toContain("workspace");
  });

  it("redacts every credential and the full private-key block", () => {
    const masked = maskSensitive(
      "api_key=abcdefghijklmnop\n" +
        "api_key=qrstuvwxyzabcdef\n" +
        "-----BEGIN PRIVATE KEY-----\nsecret material\n-----END PRIVATE KEY-----",
    );

    expect(masked).not.toContain("abcdefghijklmnop");
    expect(masked).not.toContain("qrstuvwxyzabcdef");
    expect(masked).not.toContain("secret material");
  });
});
