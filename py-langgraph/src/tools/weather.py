"""
get_weather — 查询指定城市的实时天气信息
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
    description="查询指定城市的实时天气信息（温度、天气状况、风速等）。当用户问天气、气温、下雨、下雪等情况时使用。",
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
    city: str = Field(description="城市名称，如 '北京'、'上海'、'New York'")


@tool(args_schema=WeatherInput)
def get_weather(city: str) -> str:
    """查询指定城市的实时天气信息（温度、天气状况、风速等）。当用户问天气、气温、下雨、下雪等情况时使用。优先通过 Open-Meteo 获取，如果失败再用 web_search 搜索。"""
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
                    "timezone": "auto",
                },
            )
            weather_res.raise_for_status()
            wdata = weather_res.json()

            c = wdata["current_weather"]
            desc = WEATHER_CODES.get(c["weathercode"], "未知")
            return f"🌤 {r['name']}（{r.get('country', '')}）当前天气：\n🌡 温度：{c['temperature']}°C\n🌦 天气：{desc}\n💨 风速：{c['windspeed']} km/h"
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
            return f"🌤 {area_name}（{country}）当前天气：\n🌡 温度：{curr['temp_C']}°C（体感 {curr['FeelsLikeC']}°C）\n🌦 天气：{curr['weatherDesc'][0]['value']}\n💨 风速：{curr['windspeedKmph']} km/h\n💧 湿度：{curr['humidity']}%"
    except Exception:
        pass

    return f"❌ 天气查询暂时不可用（网络或服务异常）。请使用 web_search 工具搜索\"{city}天气\"获取信息。"
