import { describe, expect, it } from "vitest";

import { logRequestError } from "../../src/api/middleware/error.js";

describe("request error logging", () => {
  it("omits request content while retaining safe field metadata", () => {
    let payload: unknown;
    logRequestError(
      {
        id: "req-log-1",
        method: "POST",
        url: "/api/v1/conversations/conv_1/messages/stream",
        params: { id: "conv_1" },
        query: {},
        body: {
          content: "触发错误的测试请求",
          user_id: "user_1",
          api_key: "must-not-appear",
        },
        log: {
          error: (entry: unknown) => {
            payload = entry;
          },
        },
      },
      new Error("upstream unavailable"),
      { stream: true },
    );

    expect(payload).toMatchObject({
      request_context: {
        request_id: "req-log-1",
        body: {
          present: true,
          fields: ["api_key", "content", "user_id"],
        },
        stream: true,
      },
    });
  });
});
