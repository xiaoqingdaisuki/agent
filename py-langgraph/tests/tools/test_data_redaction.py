"""验证 test_data_redaction 对应模块的行为与边界条件"""

import base64
import json

import pytest

from src.tools.runtime.data_redaction import redact_text_content
from src.tools.runtime.executor import sanitize_result


JWT = ".".join(
    [
        base64.urlsafe_b64encode(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
        .decode()
        .rstrip("="),
        base64.urlsafe_b64encode(json.dumps({"sub": "demo-user"}).encode()).decode().rstrip("="),
        "demo_signature",
    ]
)


@pytest.mark.parametrize("name", ["password", "passwd", "pwd", "pass"])
def test_redacts_password_value(name):
    assert redact_text_content(f"{name}='demo_password_123'") == f"{name}=[REDACTED]"


def test_redacts_complete_authorization_header():
    assert redact_text_content("Authorization: Basic ZHVtbXk6cGFzcw==\nstatus=200") == (
        "Authorization: [REDACTED]\nstatus=200"
    )
    assert (
        redact_text_content("Authorization: Bearer demo_access_token")
        == "Authorization: [REDACTED]"
    )


def test_preserves_public_links_versions_and_ipv4_addresses():
    text = "https://en.wikipedia.org/wiki/Agent; https://docs.python.org/3/; v1.2.3; 8.8.8.8"
    assert redact_text_content(text) == text


def test_redacts_jwts_and_sensitive_values_throughout_runtime_results():
    assert sanitize_result(
        {"link": "https://en.wikipedia.org", "nested": [JWT, "pwd=demo_password_123"]}
    ) == {
        "link": "https://en.wikipedia.org",
        "nested": ["[REDACTED]", "pwd=[REDACTED]"],
    }
