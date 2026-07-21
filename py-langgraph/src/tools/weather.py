from langchain_core.tools import tool
from pydantic import BaseModel, Field


class WeatherInput(BaseModel):
    city: str = Field(description="The city name, e.g. 'New York'")


@tool(args_schema=WeatherInput)
def get_weather(city: str) -> str:
    """Get the current weather for a city. Use this when the user asks about weather."""
    import random

    conditions = ["sunny", "cloudy", "rainy", "snowy"]
    temps = [65, 72, 80, 55, 90, 45]
    condition = random.choice(conditions)
    temp = random.choice(temps)
    return f"Weather in {city}: {temp}°F, {condition}"
