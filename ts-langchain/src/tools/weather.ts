/**
 * get_weather — 查询指定城市的实时天气 + 未来 N 天预报
 */

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";

import type { ToolDescriptor } from "./contracts.js";

// ============ WMO Weather Codes ============

const WEATHER_CODES: Record<number, string> = {
  0: "晴朗",
  1: "大部晴朗",
  2: "多云",
  3: "阴天",
  45: "雾",
  48: "雾凇",
  51: "小毛毛雨",
  53: "中毛毛雨",
  55: "大毛毛雨",
  61: "小雨",
  63: "中雨",
  65: "大雨",
  71: "小雪",
  73: "中雪",
  75: "大雪",
  77: "雪粒",
  80: "小阵雨",
  81: "中阵雨",
  82: "大阵雨",
  85: "小阵雪",
  86: "大阵雪",
  95: "雷暴",
  96: "雷暴伴小冰雹",
  99: "雷暴伴大冰雹",
};

// ============ Tool Descriptor ============

export const weatherInputSchema = z.object({
  city: z
    .string()
    .describe(
      "城市名称，支持中文如 '北京' '上海' '深圳'，也支持英文如 'Beijing' 'Shanghai'",
    ),
  days: z
    .number()
    .int()
    .min(1)
    .max(7)
    .default(7)
    .describe("预报天数，默认 7 天"),
});

export const weatherDescriptor: ToolDescriptor = {
  name: "weather.current",
  version: "1.0.0",
  title: "天气查询",
  description:
    "查询指定城市的实时天气及未来 7 天天气预报（温度、天气状况、风速等）。当用户问天气、气温、下雨、下雪、冷不冷、热不热、未来几天天气时使用。优先通过 Open-Meteo 获取，如果失败再用 web.search 搜索。",
  category: "READ",
  risk_level: "R1",
  side_effect: "read",
  timeout_ms: 10000,
  required_permissions: ["weather.read"],
  data_classification: ["internal"],
  owner: "tools",
  tags: ["weather", "location"],
  input_schema: weatherInputSchema,
};

// ============ LangChain Tool ============

export const weatherTool: DynamicStructuredTool = new DynamicStructuredTool({
  name: "get_weather",
  description:
    "【天气查询工具】查询指定城市的实时天气及未来 7 天天气预报。用户问天气、气温、下雨、下雪、冷不冷、热不热、未来几天天气时，必须先调用此工具。优先通过 Open-Meteo 获取，如果失败再用 web.search 搜索。",
  schema: weatherInputSchema,
  func: async ({ city, days = 7 }) => {
    const signal = AbortSignal.timeout(10000);
    // 尝试 Open-Meteo
    try {
      const geoRes = await fetch(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=zh&format=json`,
        { signal },
      );
      if (!geoRes.ok) throw new Error(`Geocoding HTTP ${geoRes.status}`);
      const geoData = (await geoRes.json()) as {
        results?: Array<{
          latitude: number;
          longitude: number;
          name: string;
          country?: string;
        }>;
      };
      if (!geoData.results?.length) throw new Error(`找不到城市: ${city}`);

      const { latitude, longitude, name, country } = geoData.results[0];

      const weatherRes = await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current_weather=true&daily=temperature_2m_max,temperature_2m_min,weathercode&timezone=auto&forecast_days=${days}`,
        { signal },
      );
      if (!weatherRes.ok) throw new Error(`Weather HTTP ${weatherRes.status}`);
      const weatherData = (await weatherRes.json()) as {
        current_weather: {
          temperature: number;
          weathercode: number;
          windspeed: number;
        };
        daily?: {
          time: string[];
          temperature_2m_max: number[];
          temperature_2m_min: number[];
          weathercode: number[];
        };
      };

      const c = weatherData.current_weather;
      const desc = WEATHER_CODES[c.weathercode] || "未知";
      const lines: string[] = [
        `🌤 ${name}（${country ?? ""}）当前天气：`,
        `🌡 温度：${c.temperature}°C`,
        `🌦 天气：${desc}`,
        `💨 风速：${c.windspeed} km/h`,
      ];

      if (weatherData.daily?.time?.length) {
        lines.push("");
        lines.push(`📅 未来 ${weatherData.daily.time.length} 天预报：`);
        for (let i = 0; i < weatherData.daily.time.length; i++) {
          const date = weatherData.daily.time[i];
          const maxT = weatherData.daily.temperature_2m_max[i];
          const minT = weatherData.daily.temperature_2m_min[i];
          const wcode = weatherData.daily.weathercode[i];
          const wdesc = WEATHER_CODES[wcode] || "未知";
          const dayLabel =
            i === 0
              ? "今天"
              : i === 1
                ? "明天"
                : `周${"日一二三四五六"[new Date(date).getDay()]}`;
          lines.push(
            `  ${dayLabel}(${date.slice(5)}) ${wdesc} ${minT}°C ~ ${maxT}°C`,
          );
        }
      }

      return lines.join("\n");
    } catch {
      // Open-Meteo 失败，尝试 wttr.in 备用
      try {
        const wttrRes = await fetch(
          `https://wttr.in/${encodeURIComponent(city)}?format=j1&lang=zh`,
          {
            headers: { "User-Agent": "curl/7.68" },
            signal,
          },
        );
        if (wttrRes.ok) {
          const wData = (await wttrRes.json()) as {
            current_condition: Array<{
              temp_C: string;
              FeelsLikeC: string;
              weatherDesc: Array<{ value: string }>;
              windspeedKmph: string;
              humidity: string;
            }>;
            nearest_area: Array<{
              areaName: Array<{ value: string }>;
              country: Array<{ value: string }>;
            }>;
            weather: Array<{
              date: string;
              maxtempC: string;
              mintempC: string;
              hourly: Array<{
                time: string;
                weatherDesc: Array<{ value: string }>;
              }>;
            }>;
          };
          const curr = wData.current_condition[0];
          const area = wData.nearest_area[0];
          const areaName = area.areaName[0].value;
          const country = area.country[0].value;
          const lines: string[] = [
            `🌤 ${areaName}（${country}）当前天气：`,
            `🌡 温度：${curr.temp_C}°C（体感 ${curr.FeelsLikeC}°C）`,
            `🌦 天气：${curr.weatherDesc[0].value}`,
            `💨 风速：${curr.windspeedKmph} km/h`,
            `💧 湿度：${curr.humidity}%`,
          ];

          if (wData.weather?.length) {
            lines.push("");
            lines.push(`📅 未来 ${wData.weather.length} 天预报：`);
            for (const day of wData.weather) {
              const desc = day.hourly[4]?.weatherDesc[0]?.value || "未知";
              lines.push(
                `  ${day.date} ${desc} ${day.mintempC}°C ~ ${day.maxtempC}°C`,
              );
            }
          }

          return lines.join("\n");
        }
      } catch {
        // wttr.in 也失败了
      }
      return `🌤 天气查询暂时不可用（网络或服务异常）。你可以直接告诉用户当前无法查询天气，并建议稍后重试。`;
    }
  },
});
