from src.commands import (
    DARK_MODE_COMMAND,
    DARK_MODE_DISABLED_REPLY,
    DARK_MODE_ENABLED_REPLY,
    clear_agent_command_state,
    execute_agent_command,
    get_agent_prompt_override,
)
from src.prompts.system import DARK_MODE_PROMPT


def test_dark_mode_command_toggles_prompt_for_one_thread():
    thread_id = "command-thread"
    clear_agent_command_state(thread_id)

    result = execute_agent_command(DARK_MODE_COMMAND, thread_id)
    assert result is not None
    assert result.reply == DARK_MODE_ENABLED_REPLY
    assert get_agent_prompt_override(thread_id) == DARK_MODE_PROMPT

    result = execute_agent_command(f"  {DARK_MODE_COMMAND}  ", thread_id)
    assert result is not None
    assert result.reply == DARK_MODE_DISABLED_REPLY
    assert get_agent_prompt_override(thread_id) is None


def test_command_ignores_normal_messages_and_isolates_thread_state():
    thread_id = "isolated-command-thread"
    clear_agent_command_state(thread_id)

    assert execute_agent_command("你好", thread_id) is None
    execute_agent_command(DARK_MODE_COMMAND, thread_id)
    assert get_agent_prompt_override("another-thread") is None

    clear_agent_command_state(thread_id)


def test_vibe_formatted_conversation_restores_mode_without_stable_thread_id():
    formatted_command = f"user: {DARK_MODE_COMMAND}"
    result = execute_agent_command(formatted_command, "random-thread-1")
    assert result is not None
    assert result.reply == DARK_MODE_ENABLED_REPLY

    next_request = "\n\n".join([
        formatted_command,
        f"assistant: {DARK_MODE_ENABLED_REPLY}",
        "user: 你好",
    ])
    assert get_agent_prompt_override("random-thread-2", next_request) == DARK_MODE_PROMPT

    disabled_request = "\n\n".join([
        next_request,
        "assistant: 大公鸡模式回答",
        f"user: {DARK_MODE_COMMAND}",
    ])
    result = execute_agent_command(disabled_request, "random-thread-3")
    assert result is not None
    assert result.reply == DARK_MODE_DISABLED_REPLY
    assert get_agent_prompt_override("random-thread-3", disabled_request) is None
