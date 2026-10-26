"""验证 D1 检查点存储的兼容性"""

import pytest
import httpx
from langchain_core.messages import AIMessage, HumanMessage
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


@pytest.mark.asyncio
async def test_gateway_failure_retains_the_first_local_turn():
    saver = D1Checkpointer(gateway_base_url="http://localhost")
    client = httpx.AsyncClient(
        base_url="http://localhost",
        transport=httpx.MockTransport(lambda request: httpx.Response(503)),
    )
    saver._async_client = client
    checkpoint = empty_checkpoint()
    checkpoint["channel_values"]["messages"] = [
        HumanMessage(content="first question"),
        AIMessage(content="first answer"),
    ]
    checkpoint["channel_versions"]["messages"] = "1"
    config = {"configurable": {"thread_id": "outage-thread", "checkpoint_ns": ""}}

    try:
        saved_config = await saver.aput(config, checkpoint, {}, checkpoint["channel_versions"])
        restored = await saver.aget_tuple(saved_config)

        assert [
            message.content for message in restored.checkpoint["channel_values"]["messages"]
        ] == [
            "first question",
            "first answer",
        ]
    finally:
        await client.aclose()
