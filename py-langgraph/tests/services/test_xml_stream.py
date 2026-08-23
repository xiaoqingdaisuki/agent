from src.services import drain_xml_tool_stream


def test_drain_xml_tool_stream_hides_invoke_calls():
    buffer = ""
    visible = ""
    for chunk in (
        "<inv",
        'oke name="memory_user_search"><parameter name="query">用户',
        "身份个人信息</parameter></invoke>",
        "已完成",
    ):
        buffer += chunk
        chunk_visible, buffer = drain_xml_tool_stream(buffer)
        visible += chunk_visible

    tail, _ = drain_xml_tool_stream(buffer, final=True)
    assert visible + tail == "已完成"


def test_drain_xml_tool_stream_hides_dots_function_calls():
    buffer = ""
    visible = ""
    for chunk in (
        "<dots_function_call><search><query>深圳南山区",
        "美食推荐</query></search></dots_function_call>",
        "已完成",
    ):
        buffer += chunk
        chunk_visible, buffer = drain_xml_tool_stream(buffer)
        visible += chunk_visible

    tail, _ = drain_xml_tool_stream(buffer, final=True)
    assert visible + tail == "已完成"
