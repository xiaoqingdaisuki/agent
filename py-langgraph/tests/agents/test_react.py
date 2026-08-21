from langchain_core.messages import ToolMessage

from src.agents.react import (
    is_clarification,
    observation_from_tool_message,
    summarize_react_state,
    tool_call_signature,
)


def test_react_signature_is_stable_for_argument_order():
    assert tool_call_signature("web.search", {"b": 2, "a": 1}) == tool_call_signature(
        "web.search", {"a": 1, "b": 2}
    )


def test_tool_message_becomes_observation_envelope():
    message = ToolMessage(
        content='{"status":"success","data":{"value":4},"error":null}',
        tool_call_id="call-1",
        name="calculator",
    )

    observation = observation_from_tool_message(message)

    assert observation.tool_call_id == "call-1"
    assert observation.tool == "calculator"
    assert observation.status == "success"
    assert observation.data == {"value": 4}


def test_react_summary_and_clarification_detection():
    assert is_clarification("请问你想查询哪个城市的天气？")
    summary = summarize_react_state(
        {
            "react_state": "COMPLETED",
            "stop_reason": "ANSWER_COMPLETE",
            "react_steps": 2,
            "react_tool_calls": 1,
            "react_tool_names": ["weather.current"],
            "tool_errors": 0,
            "model_calls": 2,
            "observations": [],
            "total_latency_ms": 12,
        }
    )
    assert summary["stop_reason"] == "ANSWER_COMPLETE"
    assert summary["tool_calls"] == 1
