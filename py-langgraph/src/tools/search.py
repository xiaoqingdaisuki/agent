from langchain_core.tools import tool
from pydantic import BaseModel, Field
import httpx
import re
from html import unescape

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


def _clean_html(text: str) -> str:
    text = unescape(text)
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


# ============ Weather Tool ============

class WeatherInput(BaseModel):
    city: str = Field(description="城市名称，如 '北京'、'上海'、'深圳'")


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


# ============ Web Search Tool (Multi-source) ============

def _search_bing(query: str) -> str | None:
    with httpx.Client(timeout=10) as client:
        res = client.get(
            "https://www.bing.com/search",
            params={"q": query, "setmkt": "zh-CN"},
            headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            },
        )
        if not res.is_success:
            return None

    html = res.text
    results = []
    seen = set()

    for match in re.finditer(r'<li class="b_algo"[^>]*>(.*?)</li>', html, re.DOTALL):
        item = match.group(1)
        title_match = re.search(r'<h2><a href="([^"]+)"[^>]*>(.*?)</a></h2>', item, re.DOTALL)
        if not title_match:
            continue

        url = title_match.group(1)
        title = _clean_html(title_match.group(2))
        if not title or url in seen:
            continue
        seen.add(url)

        snippet_match = re.search(r"<p[^>]*>(.*?)</p>", item, re.DOTALL)
        snippet = _clean_html(snippet_match.group(1)) if snippet_match else "无摘要"

        results.append(f"• {title}\n  {url}\n  {snippet}")
        if len(results) >= 5:
            break

    return f"🔍 搜索结果（{query}）：\n\n" + "\n\n".join(results) if results else None


def _search_searx(query: str) -> str | None:
    instances = [
        "https://search.sapti.me",
        "https://searx.be",
        "https://search.bus-hit.me",
    ]

    for instance in instances:
        try:
            with httpx.Client(timeout=8) as client:
                res = client.get(
                    f"{instance}/search",
                    params={"q": query, "format": "json", "engines": "google,bing,duckduckgo", "pageno": "1"},
                    headers={"Accept": "application/json", "User-Agent": "curl/7.68"},
                )
                if not res.is_success:
                    continue
                data = res.json()

                if data.get("results"):
                    items = data["results"][:5]
                    results = [f"• {r['title']}\n  {r['url']}\n  {(r.get('content') or '')[:100]}" for r in items]
                    return f"🔍 搜索结果（{query}）：\n\n" + "\n\n".join(results)
        except Exception:
            continue

    return None


def _search_duckduckgo(query: str) -> str | None:
    with httpx.Client(timeout=8) as client:
        res = client.get(
            "https://api.duckduckgo.com/",
            params={"q": query, "format": "json", "no_html": 1, "skip_disambig": 1},
        )
        if not res.is_success:
            return None

    data = res.json()
    results = []

    if data.get("Abstract"):
        results.append(f"📋 {data['Abstract']}")
        if data.get("AbstractURL"):
            results.append(f"   来源：{data['AbstractURL']}")

    if data.get("RelatedTopics"):
        results.append("\n📌 相关结果：")
        for topic in data["RelatedTopics"][:5]:
            if topic.get("Text") and "search for" not in topic["Text"]:
                results.append(f"• {topic['Text']}")
                if topic.get("FirstURL"):
                    results.append(f"  链接：{topic['FirstURL']}")

    return "\n".join(results) if results else None


class SearchInput(BaseModel):
    query: str = Field(description="搜索关键词，尽量简洁明确，例如'深圳8月28日活动'")


@tool(args_schema=SearchInput)
def web_search(query: str) -> str:
    """【强制联网搜索】在互联网上搜索最新信息并返回事实核查结果。当用户问及任何可能需要事实核查的内容时，无论是否属于你的训练知识范围，都必须调用此工具：历史事件、时事新闻、政策法规、具体数据和统计、人物动态、公司和产品信息、体育赛事比分、学术研究、百科知识、节日纪念日、地理位置、语言翻译、影视书籍评价等。模型训练数据有截止日期且可能不准确，只有联网搜索能保证信息的时效性和准确性。不要凭训练记忆回答任何事实性问题。"""
    # 1) Bing
    try:
        result = _search_bing(query)
        if result:
            return result
    except Exception:
        pass

    # 2) Searx
    try:
        result = _search_searx(query)
        if result:
            return result
    except Exception:
        pass

    # 3) DuckDuckGo
    try:
        result = _search_duckduckgo(query)
        if result:
            return result
    except Exception:
        pass

    return f"❌ 搜索暂时不可用，无法获取关于\"{query}\"的信息。请稍后重试。"


# ============ Fetch URL Tool ============

class FetchUrlInput(BaseModel):
    url: str = Field(description="要获取内容的网页URL，必须是完整的URL（包含 https:// 或 http://）")


@tool(args_schema=FetchUrlInput)
def fetch_url(url: str) -> str:
    """获取指定网页的文本内容。当需要从网页获取详细信息时使用，通常在 web_search 之后使用。"""
    try:
        with httpx.Client(timeout=10, follow_redirects=True) as client:
            res = client.get(url, headers={"User-Agent": "Mozilla/5.0 (compatible; AI-Agent/1.0)"})
            if not res.is_success:
                return f"无法获取网页：HTTP {res.status_code}"

            text = _clean_html(res.text)

            if len(text) > 5000:
                text = text[:5000] + "...\n[内容过长，已截断]"

            if len(text) < 50:
                return f"网页内容过少或无法解析：{text}"

            return f"📄 网页内容（{url}）：\n{text}"
    except Exception as e:
        return f"获取网页出错：{str(e)}"
