/**
 * time — 时间查询与时区转换工具
 *
 * 使用 IANA 时区名称，并通过 Intl API 正确处理夏令时。
 */

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";

import type { ToolDescriptor } from "./contracts.js";

const TIMEZONE_ERROR = "时区必须是有效的 IANA Time Zone，例如 Asia/Shanghai 或 America/New_York";

// 校验 IANA 时区名称并返回统一错误信息。
function validateTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
  } catch {
    throw new Error(TIMEZONE_ERROR);
  }
}

// 从 Intl 格式化结果中读取指定字段。
function getDateParts(date: Date, timezone: string): Record<string, string> {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    calendar: "iso8601",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset",
  });
  return Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value]),
  );
}

// 将 Intl 的 GMT 偏移文本转换成 ISO 8601 偏移。
function normalizeOffset(rawOffset: string): string {
  if (rawOffset === "GMT" || rawOffset === "UTC") return "+00:00";
  const match = rawOffset.match(/^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/);
  if (!match) return "+00:00";
  return `${match[1]}${match[2].padStart(2, "0")}:${match[3] ?? "00"}`;
}

// 把瞬时时间格式化为带时区偏移的 ISO 字符串。
function formatZonedDate(date: Date, timezone: string): {
  datetime: string;
  weekday: string;
} {
  const parts = getDateParts(date, timezone);
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "long",
  }).format(date);
  return {
    datetime: `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${normalizeOffset(parts.timeZoneName)}`,
    weekday,
  };
}

// 解析不带时区偏移的本地日期时间。
function parseLocalDateTime(value: string): [number, number, number, number, number, number] {
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/,
  );
  if (!match) {
    throw new Error("datetime 必须使用 YYYY-MM-DDTHH:mm:ss 格式，且不包含时区偏移");
  }
  const values = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6] ?? "0"),
  ] as [number, number, number, number, number, number];
  const check = new Date(Date.UTC(values[0], values[1] - 1, values[2], values[3], values[4], values[5]));
  if (
    check.getUTCFullYear() !== values[0] ||
    check.getUTCMonth() + 1 !== values[1] ||
    check.getUTCDate() !== values[2] ||
    check.getUTCHours() !== values[3] ||
    check.getUTCMinutes() !== values[4] ||
    check.getUTCSeconds() !== values[5]
  ) {
    throw new Error("datetime 不是有效的日期时间");
  }
  return values;
}

// 计算指定瞬时值在 IANA 时区中的 UTC 偏移毫秒数。
function getTimezoneOffsetMs(instantMs: number, timezone: string): number {
  const parts = getDateParts(new Date(instantMs), timezone);
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}

// 将来源时区中的墙上时间转换为 UTC 瞬时值。
function localTimeToInstant(values: [number, number, number, number, number, number], timezone: string): Date {
  const utcGuess = Date.UTC(values[0], values[1] - 1, values[2], values[3], values[4], values[5]);
  let instantMs = utcGuess;
  for (let i = 0; i < 3; i++) {
    instantMs = utcGuess - getTimezoneOffsetMs(instantMs, timezone);
  }
  return new Date(instantMs);
}

export const currentTimeInputSchema = z.object({
  timezone: z.string().min(1).default("Asia/Shanghai").describe("IANA 时区名称"),
});

export const currentTimeDescriptor: ToolDescriptor = {
  name: "time.current",
  version: "1.0.0",
  title: "当前时间",
  description: "获取指定 IANA 时区的当前日期、时间和星期几。",
  category: "READ",
  risk_level: "R0",
  side_effect: "none",
  timeout_ms: 2000,
  data_classification: ["public"],
  owner: "tools",
  tags: ["time", "timezone", "date"],
  input_schema: currentTimeInputSchema,
};

export const convertTimezoneInputSchema = z.object({
  datetime: z.string().min(1).describe("来源时区中的本地日期时间，如 2026-08-21T15:00:00"),
  from_timezone: z.string().min(1).describe("来源 IANA 时区"),
  to_timezone: z.string().min(1).describe("目标 IANA 时区"),
});

export const convertTimezoneDescriptor: ToolDescriptor = {
  name: "time.convert",
  version: "1.0.0",
  title: "时区转换",
  description: "将指定 IANA 时区中的本地日期时间转换为另一个 IANA 时区，自动处理夏令时。",
  category: "COMPUTE",
  risk_level: "R0",
  side_effect: "none",
  timeout_ms: 2000,
  data_classification: ["public"],
  owner: "tools",
  tags: ["time", "timezone", "convert"],
  input_schema: convertTimezoneInputSchema,
};

export const currentTimeTool: DynamicStructuredTool = new DynamicStructuredTool({
  name: "get_current_time",
  description: "获取指定时区的当前日期、时间和星期几。",
  schema: currentTimeInputSchema,
  func: async ({ timezone }) => {
    try {
      validateTimezone(timezone);
      const formatted = formatZonedDate(new Date(), timezone);
      return JSON.stringify({
        datetime: formatted.datetime,
        timezone,
        weekday: formatted.weekday,
      });
    } catch (error) {
      return JSON.stringify({ error: error instanceof Error ? error.message : TIMEZONE_ERROR });
    }
  },
});

export const convertTimezoneTool: DynamicStructuredTool = new DynamicStructuredTool({
  name: "convert_timezone",
  description: "将一个 IANA 时区的本地时间转换为另一个 IANA 时区。",
  schema: convertTimezoneInputSchema,
  func: async ({ datetime, from_timezone, to_timezone }) => {
    try {
      validateTimezone(from_timezone);
      validateTimezone(to_timezone);
      const localValues = parseLocalDateTime(datetime);
      const instant = localTimeToInstant(localValues, from_timezone);
      const formatted = formatZonedDate(instant, to_timezone);
      return JSON.stringify({
        datetime: formatted.datetime,
        timezone: to_timezone,
        weekday: formatted.weekday,
        source_datetime: datetime,
        from_timezone,
        to_timezone,
      });
    } catch (error) {
      return JSON.stringify({ error: error instanceof Error ? error.message : "时区转换失败" });
    }
  },
});
