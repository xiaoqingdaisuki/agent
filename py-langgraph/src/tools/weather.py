from langchain_core.tools import tool
from pydantic import BaseModel, Field
import httpx

WEATHER_CODES = {
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
}


class WeatherInput(BaseModel):
    city: str = Field(description="城市名称，如 '北京'、'上海'、'New York'")


@tool(args_schema=WeatherInput)
def get_weather(city: str) -> str:
    """查询指定城市的实时天气信息（温度、天气状况、风速等）。当用户问天气、气温、下雨、下雪等情况时使用。"""
    try:
        with httpx.Client(timeout=10) as client:
            # Step 1: Geocoding
            geo_res = client.get(
                "https://geocoding-api.open-meteo.com/v1/search",
                params={"name": city, "count": 1, "language": "zh", "format": "json"},
            )
            geo_data = geo_res.json()

            if not geo_data.get("results"):
                return f'找不到城市 "{city}"，请检查城市名称是否正确。'

            result = geo_data["results"][0]
            lat = result["latitude"]
            lon = result["longitude"]
            name = result["name"]
            country = result.get("country", "")

            # Step 2: Weather data
            weather_res = client.get(
                "https://api.open-meteo.com/v1/forecast",
                params={
                    "latitude": lat,
                    "longitude": lon,
                    "current_weather": "true",
                    "timezone": "auto",
                },
            )
            weather_data = weather_res.json()

            current = weather_data["current_weather"]
            temp = current["temperature"]
            wind_speed = current["windspeed"]
            code = current["weathercode"]

            desc = WEATHER_CODES.get(code, f"未知 (代码: {code})")

            return f"🌤 {name}（{country}）当前天气：\n🌡 温度：{temp}°C\n🌦 天气：{desc}\n💨 风速：{wind_speed} km/h"
    except Exception as e:
        return f"天气查询出错：{str(e)}"
