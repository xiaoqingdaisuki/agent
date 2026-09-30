import json

import pytest

from src.tools.time import convert_timezone


@pytest.mark.parametrize(
    ("zone", "value"),
    [
        ("Europe/Berlin", "2026-03-29T02:30:00"),
        ("America/New_York", "2026-03-08T02:30:00"),
        ("Australia/Lord_Howe", "2026-10-04T02:15:00"),
    ],
)
async def test_rejects_nonexistent_local_time(zone, value):
    result = json.loads(
        await convert_timezone.ainvoke(
            {
                "datetime": value,
                "from_timezone": zone,
                "to_timezone": "UTC",
            }
        )
    )
    assert result["error"] == "datetime 在来源时区不存在（夏令时切换）"


@pytest.mark.parametrize(
    ("zone", "value", "expected"),
    [
        ("Europe/Berlin", "2026-10-25T02:30:00", "2026-10-25T00:30:00+00:00"),
        ("America/New_York", "2026-11-01T01:30:00", "2026-11-01T05:30:00+00:00"),
        ("Australia/Lord_Howe", "2026-04-05T01:45:00", "2026-04-04T14:45:00+00:00"),
        ("Asia/Shanghai", "2026-08-21T15:00:00", "2026-08-21T07:00:00+00:00"),
    ],
)
async def test_selects_earlier_instant_for_ambiguous_local_time(zone, value, expected):
    result = json.loads(
        await convert_timezone.ainvoke(
            {
                "datetime": value,
                "from_timezone": zone,
                "to_timezone": "UTC",
            }
        )
    )
    assert result["datetime"] == expected
