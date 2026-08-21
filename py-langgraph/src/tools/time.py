"""time — 当前时间查询与 IANA 时区转换工具。"""

from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from langchain_core.tools import tool
from pydantic import BaseModel, Field

from src.tools.contracts import ToolDescriptor

TIMEZONE_ERROR = "时区必须是有效的 IANA Time Zone，例如 Asia/Shanghai 或 America/New_York"


class CurrentTimeInput(BaseModel):
    """当前时间工具的输入模型。"""

    timezone: str = Field(default="Asia/Shanghai", min_length=1, description="IANA 时区名称")


class ConvertTimezoneInput(BaseModel):
    """时区转换工具的输入模型。"""

    datetime: str = Field(description="来源时区中的本地日期时间，如 2026-08-21T15:00:00")
    from_timezone: str = Field(description="来源 IANA 时区")
    to_timezone: str = Field(description="目标 IANA 时区")


_CURRENT_DESCRIPTOR = ToolDescriptor(
    name="time.current",
    version="1.0.0",
    title="当前时间",
    description="获取指定 IANA 时区的当前日期、时间和星期几。",
    category="READ",
    risk_level="R0",
    side_effect="none",
    timeout_ms=2000,
    data_classification=["public"],
    owner="tools",
    tags=["time", "timezone", "date"],
)

_CONVERT_DESCRIPTOR = ToolDescriptor(
    name="time.convert",
    version="1.0.0",
    title="时区转换",
    description="将指定 IANA 时区中的本地日期时间转换为另一个 IANA 时区，自动处理夏令时。",
    category="COMPUTE",
    risk_level="R0",
    side_effect="none",
    timeout_ms=2000,
    data_classification=["public"],
    owner="tools",
    tags=["time", "timezone", "convert"],
)


# 校验 IANA 时区名称并返回 ZoneInfo。
def _timezone(name: str) -> ZoneInfo:
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise ValueError(TIMEZONE_ERROR) from exc


# 将时间格式化为需求文档约定的 JSON 数据。
def _format_time(value: datetime, timezone: str) -> dict[str, str]:
    local = value.astimezone(_timezone(timezone))
    return {
        "datetime": local.isoformat(timespec="seconds"),
        "timezone": timezone,
        "weekday": local.strftime("%A"),
    }


# 获取指定时区的当前日期、时间和星期几。
@tool(args_schema=CurrentTimeInput)
# 执行 get current time 对应的业务逻辑
def get_current_time(timezone: str = "Asia/Shanghai") -> str:
    """获取指定 IANA 时区的当前日期、时间和星期几。"""
    import json

    try:
        return json.dumps(_format_time(datetime.now(_timezone(timezone)), timezone), ensure_ascii=False)
    except ValueError as exc:
        return json.dumps({"error": str(exc)}, ensure_ascii=False)


# 将来源时区的本地日期时间转换为目标时区。
@tool(args_schema=ConvertTimezoneInput)
# 执行 convert timezone 对应的业务逻辑
def convert_timezone(datetime: str, from_timezone: str, to_timezone: str) -> str:
    """将一个 IANA 时区的本地时间转换为另一个 IANA 时区。"""
    import json

    try:
        source = _timezone(from_timezone)
        _timezone(to_timezone)
        parsed = __import__("datetime").datetime.fromisoformat(datetime.replace("Z", "+00:00"))
        if parsed.tzinfo is not None:
            raise ValueError("datetime 必须是不带时区偏移的本地日期时间")
        instant = parsed.replace(tzinfo=source)
        result = _format_time(instant, to_timezone)
        result.update(
            {
                "source_datetime": datetime,
                "from_timezone": from_timezone,
                "to_timezone": to_timezone,
            }
        )
        return json.dumps(result, ensure_ascii=False)
    except (ValueError, TypeError) as exc:
        return json.dumps({"error": str(exc)}, ensure_ascii=False)


__all__ = [
    "_CONVERT_DESCRIPTOR",
    "_CURRENT_DESCRIPTOR",
    "ConvertTimezoneInput",
    "CurrentTimeInput",
    "convert_timezone",
    "get_current_time",
]
