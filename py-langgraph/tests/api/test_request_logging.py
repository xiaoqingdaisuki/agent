import json
import logging

from starlette.requests import Request

from src.api.request_logging import log_request_error, sanitize_log_value


def test_request_log_redacts_sensitive_fields_without_transforming_safe_values():
    payload = sanitize_log_value(
        {
            "content": "触发错误的测试请求",
            "user_id": "user_1",
            "api_key": "must-not-appear",
        }
    )

    assert payload == {
        "content": "触发错误的测试请求",
        "user_id": "user_1",
        "api_key": "[REDACTED]",
    }


def test_request_log_contains_ts_compatible_error_and_request_context(caplog):
    request = Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/api/v1/conversations/conv_1/messages/stream",
            "raw_path": b"/api/v1/conversations/conv_1/messages/stream",
            "query_string": b"debug=true",
            "headers": [
                (b"host", b"testserver"),
                (b"x-request-id", b"req-log-1"),
            ],
            "scheme": "http",
            "server": ("testserver", 80),
            "client": ("testclient", 1234),
            "root_path": "",
        }
    )
    request._body = b'{"content":"trigger","api_key":"must-not-appear"}'

    with caplog.at_level(logging.ERROR, logger="agent.request"):
        try:
            raise RuntimeError("upstream unavailable")
        except RuntimeError as error:
            log_request_error(request, error, {"stream": True})

    record = next(record for record in caplog.records if record.name == "agent.request")
    payload = json.loads(record.getMessage().split("Agent request failed | ", 1)[1])

    assert payload["err"]["type"] == "RuntimeError"
    assert payload["err"]["message"] == "upstream unavailable"
    assert "RuntimeError: upstream unavailable" in payload["err"]["stack"]
    assert payload["request_context"] == {
        "request_id": "req-log-1",
        "method": "POST",
        "url": "http://testserver/api/v1/conversations/conv_1/messages/stream?debug=true",
        "params": {},
        "query": {"debug": "true"},
        "body": {"present": True, "fields": ["api_key", "content"]},
        "stream": True,
    }
    assert record.exc_info is not None
