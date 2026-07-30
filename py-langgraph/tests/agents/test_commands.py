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
