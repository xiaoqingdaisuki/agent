from src.api.request_logging import sanitize_log_value


def test_request_log_preserves_content_and_redacts_sensitive_fields():
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
