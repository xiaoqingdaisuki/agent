"""Test XML tool call conversion - pytest compatible"""
import os
import sys

# Ensure src is importable
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
os.chdir(os.path.join(os.path.dirname(__file__), ".."))

from langchain_core.messages import AIMessage

from src.agents.base import _convert_xml_tool_calls

# Build XML content using string concat to avoid literal XML patterns
F_OPEN = chr(60) + "function=get_weather>"       # <
F_CLOSE = chr(60) + "/function>"                 # </>
P_OPEN = chr(60) + "parameter=city>"             # <
P_CLOSE = chr(60) + "/parameter>"                # </


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
