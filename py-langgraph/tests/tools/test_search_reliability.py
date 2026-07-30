"""Deterministic tests for the Tavily web-search reliability layer."""

import pytest

from src.tools import search


@pytest.fixture(autouse=True)
def clean_search_state(monkeypatch):
    for key in ("TAVILY_API_KEY", "SEARCH_CACHE_TTL_SECONDS", "TAVILY_SEARCH_DEPTH"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setattr(search.app_settings, "tavily_api_key", "")
    search.reset_search_state_for_tests()


def item(title: str, url: str) -> search.SearchResultItem:
    return search.SearchResultItem(title=title, url=url, snippet="snippet")


def test_reports_configuration_error_without_network(monkeypatch):
    called = False

    def fake_tavily(query, settings):
        nonlocal called
        called = True
        return []

    monkeypatch.setattr(search, "_search_tavily", fake_tavily)
    outcome = search.multi_source_search("实时测试")

    assert called is False
    assert outcome.failed_providers == ["tavily:not_configured"]
    assert "Tavily 实时搜索暂时不可用" in search.search_results_to_text(outcome, "实时测试")


def test_returns_tavily_results_and_short_cache(monkeypatch):
    monkeypatch.setenv("TAVILY_API_KEY", "test-key")
    monkeypatch.setenv("SEARCH_CACHE_TTL_SECONDS", "60")
    calls = 0

    def fake_tavily(query, settings):
        nonlocal calls
        calls += 1
        return [item("实时结果", "https://example.com/live")]

    monkeypatch.setattr(search, "_search_tavily", fake_tavily)
    first = search.multi_source_search("cache test")
    cached = search.multi_source_search("cache   test")

    assert first.providers == ["tavily"]
    assert cached.cached is True
    assert calls == 1


def test_tavily_parser_canonicalizes_and_deduplicates_urls(monkeypatch):
    class FakeResponse:
        @staticmethod
        def json():
            return {
                "results": [
                    {
                        "title": "<b>实时结果</b>",
                        "url": "https://example.com/live?utm_source=test",
                        "content": "最新摘要",
                    },
                    {
                        "title": "重复结果",
                        "url": "https://example.com/live",
                        "content": "duplicate",
                    },
                ]
            }

    monkeypatch.setattr(search, "_request_tavily", lambda settings, query: FakeResponse())
    settings = search.SearchSettings("key", 1, 8, 30, 600, "basic")
    results = search._search_tavily("test", settings)

    assert len(results) == 1
    assert results[0].title == "实时结果"
    assert results[0].url == "https://example.com/live"
