/** 验证 tools/test_time 对应模块的行为与边界条件 */

import { describe, expect, it } from "vitest";
import { convertTimezoneTool } from "../../src/tools/time.js";

describe("timezone conversion transition boundaries", () => {
  it.each([
    ["Europe/Berlin", "2026-03-29T02:30:00"],
    ["America/New_York", "2026-03-08T02:30:00"],
    ["Australia/Lord_Howe", "2026-10-04T02:15:00"],
  ])("rejects nonexistent local time in %s", async (zone, datetime) => {
    const result = JSON.parse(await convertTimezoneTool.invoke({ datetime, from_timezone: zone, to_timezone: "UTC" }));
    expect(result.error).toBe("datetime 在来源时区不存在（夏令时切换）");
  });

  it.each([
    ["Europe/Berlin", "2026-10-25T02:30:00", "2026-10-25T00:30:00+00:00"],
    ["America/New_York", "2026-11-01T01:30:00", "2026-11-01T05:30:00+00:00"],
    ["Australia/Lord_Howe", "2026-04-05T01:45:00", "2026-04-04T14:45:00+00:00"],
    ["Asia/Shanghai", "2026-08-21T15:00:00", "2026-08-21T07:00:00+00:00"],
  ])("selects the earlier instant for ambiguous local time in %s", async (zone, datetime, expected) => {
    const result = JSON.parse(await convertTimezoneTool.invoke({ datetime, from_timezone: zone, to_timezone: "UTC" }));
    expect(result.datetime).toBe(expected);
  });
});
