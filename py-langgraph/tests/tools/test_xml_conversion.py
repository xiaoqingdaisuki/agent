"""Test XML tool call conversion - pytest compatible"""
import os
import sys

# Ensure src is importable
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
os.chdir(os.path.join(os.path.dirname(__file__), ".."))

from langchain_core.messages import AIMessage

from src.agents.graph_agents import _convert_xml_tool_calls

# Build XML content using string concat to avoid literal XML patterns
F_OPEN = chr(60) + "function=get_weather>"       # <
F_CLOSE = chr(60) + "/function>"                 # </>
P_OPEN = chr(60) + "parameter=city>"             # <
P_CLOSE = chr(60) + "/parameter>"                # </
INVOKE_OPEN = chr(60) + 'invoke name="memory_user_search">'
INVOKE_CLOSE = chr(60) + "/invoke>"
NAMED_PARAM_OPEN = chr(60) + 'parameter name="query">'
DOTS_OPEN = chr(60) + "dots_function_call><search>"
DOTS_CLOSE = chr(60) + "/search></dots_function_call>"


def test_convert_xml_tool_calls():
    """XML format tool calls should be converted to standard AIMessage.tool_calls"""
    xml_content = F_OPEN + "\n" + P_OPEN + "\n北京\n" + P_CLOSE + "\n" + F_CLOSE
    msg = AIMessage(content=xml_content)
    result = _convert_xml_tool_calls(msg)

    assert result.tool_calls is not None
    assert len(result.tool_calls) == 1
    assert result.tool_calls[0]["name"] == "get_weather"
    assert result.tool_calls[0]["args"]["city"] == "北京"
    assert "function=get_weather" not in result.content


def test_non_xml_unchanged():
    """Non-XML messages should pass through unchanged"""
    msg = AIMessage(content="Hello world")
    result = _convert_xml_tool_calls(msg)
    assert result.content == "Hello world"
    assert not result.tool_calls


def test_already_standard_tool_calls():
    """Messages with standard tool_calls should pass through"""
    msg = AIMessage(
        content="",
        tool_calls=[{"name": "test", "args": {}, "id": "call_1"}],
    )
    result = _convert_xml_tool_calls(msg)
    assert result.tool_calls == msg.tool_calls


def test_multiple_xml_calls():
    """Multiple XML tool calls should all be converted"""
    xml = (
        F_OPEN + "\n" + P_OPEN + "\nBeijing\n" + P_CLOSE + "\n" + F_CLOSE + "\n"
        + F_OPEN + "\n" + P_OPEN + "\nhello\n" + P_CLOSE + "\n" + F_CLOSE
    )
    msg = AIMessage(content=xml)
    result = _convert_xml_tool_calls(msg)
    assert len(result.tool_calls) == 2
    assert [call["id"] for call in result.tool_calls] == [
        "call_get_weather_1",
        "call_get_weather_2",
    ]


def test_invoke_name_xml_tool_call():
    """Provider invoke/name XML calls should be converted and removed from content."""
    xml_content = (
        INVOKE_OPEN
        + "\n"
        + NAMED_PARAM_OPEN
        + "\n用户身份个人信息\n"
        + P_CLOSE
        + "\n"
        + INVOKE_CLOSE
    )
    result = _convert_xml_tool_calls(AIMessage(content=xml_content))

    assert result.content == ""
    assert result.tool_calls == [
        {
            "name": "memory_user_search",
            "args": {"query": "用户身份个人信息"},
            "id": "call_memory_user_search_1",
            "type": "tool_call",
        }
    ]


def test_invoke_name_xml_normalizes_descriptor_tool_name():
    """Descriptor names must resolve to the actual registered LangGraph tool."""
    xml_content = (
        '<invoke name="web.search">'
        '<parameter name="query">南山美食</parameter>'
        "</invoke>"
    )
    result = _convert_xml_tool_calls(AIMessage(content=xml_content))

    assert result.tool_calls == [
        {
            "name": "web_search",
            "args": {"query": "南山美食"},
            "id": "call_web_search_1",
            "type": "tool_call",
        }
    ]


def test_dots_function_search_calls_are_converted_and_removed():
    """dots function call envelopes should become web search tool calls."""
    xml_content = (
        DOTS_OPEN
        + "<query>深圳南山区 2026年8月天气游玩</query>"
        + "<query>深圳南山区美食推荐</query>"
        + DOTS_CLOSE
    )

    result = _convert_xml_tool_calls(AIMessage(content=xml_content))

    assert result.content == ""
    assert [call["name"] for call in result.tool_calls] == ["web_search", "web_search"]
    assert [call["args"]["query"] for call in result.tool_calls] == [
        "深圳南山区 2026年8月天气游玩",
        "深圳南山区美食推荐",
    ]
