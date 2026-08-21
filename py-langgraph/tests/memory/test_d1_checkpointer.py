"""D1 checkpointer compatibility tests."""

import pytest
from langgraph.checkpoint.base import empty_checkpoint

from src.memory.d1_checkpointer import D1Checkpointer


def test_sync_checkpoint_api_matches_current_langgraph():
    saver = D1Checkpointer()
    checkpoint = empty_checkpoint()
    config = {"configurable": {"thread_id": "sync-thread", "checkpoint_ns": ""}}

    saved_config = saver.put(config, checkpoint, {}, checkpoint["channel_versions"])

    assert saver.get(saved_config)["id"] == checkpoint["id"]
    saver.put_writes(saved_config, [("messages", "value")], "task-1")
    saver.delete_thread("sync-thread")
    assert saver.get(saved_config) is None


@pytest.mark.asyncio
async def test_async_checkpoint_api_matches_current_langgraph():
    saver = D1Checkpointer()
    checkpoint = empty_checkpoint()
    config = {"configurable": {"thread_id": "async-thread", "checkpoint_ns": ""}}

    saved_config = await saver.aput(config, checkpoint, {}, checkpoint["channel_versions"])

    assert (await saver.aget_tuple(saved_config)).checkpoint["id"] == checkpoint["id"]
    await saver.aput_writes(saved_config, [("messages", "value")], "task-1")
    await saver.adelete_thread("async-thread")
    assert await saver.aget_tuple(saved_config) is None
