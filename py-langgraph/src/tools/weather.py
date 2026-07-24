"""
get_weather — 查询指定城市的实时天气 + 未来 N 天预报
"""

from __future__ import annotations

from typing import Any

import httpx

from langchain_core.tools import tool
from pydantic import BaseModel, Field

from src.tools.contracts import (
    ToolCategory,
    ToolDescriptor,
    ToolResultEnvelope,
    ToolResultMeta,
    SideEffect,
)

# ============ WMO Weather Codes ============

WEATHER_CODES = {
    0: "晴朗", 1: "大部晴朗", 2: "多云", 3: "阴天",
    45: "雾", 48: "雾凇",
    51: "小毛毛雨", 53: "中毛毛雨", 55: "大毛毛雨",
    61: "小雨", 63: "中雨", 65: "大雨",
    71: "小雪", 73: "中雪", 75: "大雪", 77: "雪粒",
    80: "小阵雨", 81: "中阵雨", 82: "大阵雨",
    85: "小阵雪", 86: "大阵雪",
    95: "雷暴", 96: "雷暴伴小冰雹", 99: "雷暴伴大冰雹",
}


# ============ Tool Descriptor ============

_DESCRIPTOR = ToolDescriptor(
    name="weather.current",
    version="1.0.0",
    title="天气查询",
    description="查询指定城市的实时天气及未来 7 天天气预报（温度、天气状况、风速等）。当用户问天气、气温、下雨、下雪等情况时使用。",
    category="READ",
    risk_level="R1",
    side_effect="read",
    timeout_ms=10000,
    required_permissions=["weather.read"],
    data_classification=["internal"],
    owner="tools",
    tags=["weather", "location"],
)


# ============ LangChain Tool ============

class WeatherInput(BaseModel):
    city: str = Field(description="城市名称，如 '北京'、'上海'、'深圳'")
    days: int = Field(default=7, ge=1, le=7, description="预报天数，默认 7 天，范围 1-7")


@tool(args_schema=WeatherInput)
def get_weather(city: str, days: int = 7) -> str:
    """查询指定城市的实时天气及未来 7 天天气预报。当用户问天气、气温、下雨、下雪等情况时使用。优先通过 Open-Meteo 获取，如果失败再用 web_search 搜索。"""
    # 尝试 Open-Meteo
    try:
        with httpx.Client(timeout=10) as client:
            geo_res = client.get(
                "https://geocoding-api.open-meteo.com/v1/search",
                params={"name": city, "count": 1, "language": "zh", "format": "json"},
            )
            geo_res.raise_for_status()
            geo_data = geo_res.json()

            if not geo_data.get("results"):
                raise ValueError(f"找不到城市: {city}")

            r = geo_data["results"][0]
            weather_res = client.get(
                "https://api.open-meteo.com/v1/forecast",
                params={
                    "latitude": r["latitude"],
                    "longitude": r["longitude"],
                    "current_weather": "true",
                    "daily": "temperature_2m_max,temperature_2m_min,weathercode",
                    "timezone": "auto",
                    "forecast_days": days,
                },
            )
            weather_res.raise_for_status()
            wdata = weather_res.json()

            c = wdata["current_weather"]
            desc = WEATHER_CODES.get(c["weathercode"], "未知")
            lines = [
                f"🌤 {r['name']}（{r.get('country', '')}）当前天气：",
                f"🌡 温度：{c['temperature']}°C",
                f"🌦 天气：{desc}",
                f"💨 风速：{c['windspeed']} km/h",
            ]

            daily = wdata.get("daily")
            if daily and daily.get("time"):
                lines.append("")
                lines.append(f"📅 未来 {len(daily['time'])} 天预报：")
                for i, date in enumerate(daily["time"]):
                    max_t = daily["temperature_2m_max"][i]
                    min_t = daily["temperature_2m_min"][i]
                    wcode = daily["weathercode"][i]
                    wdesc = WEATHER_CODES.get(wcode, "未知")
                    weekday = "今天" if i == 0 else ("明天" if i == 1 else f"周{'日一二三四五六'[__import__('datetime').datetime.strptime(date, '%Y-%m-%d').weekday()]}")
                    lines.append(f"  {weekday}({date[5:]}) {wdesc} {min_t}°C ~ {max_t}°C")

            return "\n".join(lines)
    except Exception:
        pass

    # 备用：wttr.in
    try:
        with httpx.Client(timeout=10) as client:
            wttr_res = client.get(
                f"https://wttr.in/{city}",
                params={"format": "j1", "lang": "zh"},
                headers={"User-Agent": "curl/7.68"},
            )
            wttr_res.raise_for_status()
            wdata = wttr_res.json()
            curr = wdata["current_condition"][0]
            area = wdata["nearest_area"][0]
            area_name = area["areaName"][0]["value"]
            country = area["country"][0]["value"]
            lines = [
                f"🌤 {area_name}（{country}）当前天气：",
                f"🌡 温度：{curr['temp_C']}°C（体感 {curr['FeelsLikeC']}°C）",
                f"🌦 天气：{curr['weatherDesc'][0]['value']}",
                f"💨 风速：{curr['windspeedKmph']} km/h",
                f"💧 湿度：{curr['humidity']}%",
            ]

            if wdata.get("weather"):
                lines.append("")
                lines.append(f"📅 未来 {len(wdata['weather'])} 天预报：")
                for day in wdata["weather"]:
                    desc = day.get("hourly", [{}])[4].get("weatherDesc", [{}])[0].get("value", "未知") if day.get("hourly") else "未知"
                    lines.append(f"  {day['date']} {desc} {day['mintempC']}°C ~ {day['maxtempC']}°C")

            return "\n".join(lines)
    except Exception:
        pass

    return "🌤 天气查询暂时不可用（网络或服务异常）。你可以直接告诉用户当前无法查询天气，并建议稍后重试。"
