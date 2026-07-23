from .weather import get_weather
from .search import web_search
from .fetcher import fetch_url
from .calculator import calculator

tools = [get_weather, web_search, fetch_url, calculator]

__all__ = ["get_weather", "web_search", "fetch_url", "calculator", "tools"]
