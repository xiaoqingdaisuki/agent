import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { multiSourceSearch, resetSearchStateForTests, searchResultsToText } from "../../src/tools/web-search.js";

const SEARCH_ENV_KEYS = [
  "TAVILY_API_KEY",
  "SEARCH_CACHE_TTL_SECONDS",
  "SEARCH_MAX_ATTEMPTS",
  "TAVILY_SEARCH_DEPTH",
] as const;

describe.sequential("Tavily web search", () => {
  const originalEnv = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of SEARCH_ENV_KEYS) {
      originalEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    resetSearchStateForTests();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const key of SEARCH_ENV_KEYS) {
      const value = originalEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("reports a configuration error without making a network request", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const outcome = await multiSourceSearch("实时测试");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(outcome.failedProviders).toEqual(["tavily:not_configured"]);
    expect(searchResultsToText(outcome, "实时测试")).toContain("Tavily 实时搜索暂时不可用");
  });

  it("retries a transient Tavily failure and returns canonicalized results", async () => {
    process.env.TAVILY_API_KEY = "test-key";
    process.env.SEARCH_MAX_ATTEMPTS = "2";
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(Response.json({ results: [
        { title: "<b>实时结果</b>", url: "https://example.com/live?utm_source=test", content: "最新摘要" },
        { title: "重复结果", url: "https://example.com/live", content: "duplicate" },
      ] }));

    const outcome = await multiSourceSearch("实时测试");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(outcome.providers).toEqual(["tavily"]);
    expect(outcome.results).toHaveLength(1);
    expect(outcome.results[0]).toMatchObject({ title: "实时结果", url: "https://example.com/live" });
  });

  it("deduplicates concurrent identical searches and serves the short cache", async () => {
    process.env.TAVILY_API_KEY = "test-key";
    process.env.SEARCH_CACHE_TTL_SECONDS = "60";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ results: [
      { title: "Cached", url: "https://example.com/cached", content: "value" },
    ] }));

    const [first, concurrent] = await Promise.all([
      multiSourceSearch("cache test"),
      multiSourceSearch("cache   test"),
    ]);
    const cached = await multiSourceSearch("cache test");

    expect(first.results).toEqual(concurrent.results);
    expect(cached.cached).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
