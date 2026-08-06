"""
D1Checkpointer — 通过 Cloudflare Memory Gateway 持久化 LangGraph checkpoint

替代纯内存 MemorySaver：
- 写路径：同步写入 MemorySaver（保证 ainvoke 不阻塞），异步 POST 到 Gateway
- 读路径：首次读取时从 Gateway 加载并热启动 MemorySaver
- 删除路径：同步删除 MemorySaver，异步 DELETE Gateway

Gateway 端点：
- POST   /internal/v1/checkpoints/{thread_id}
- GET    /internal/v1/checkpoints/{thread_id}
- DELETE /internal/v1/checkpoints/{thread_id}
"""

from __future__ import annotations

import asyncio
import base64
import logging
from collections.abc import AsyncIterator, Iterator, Sequence
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from typing import Any, Optional

from langgraph.checkpoint.base import (
    BaseCheckpointSaver,
    ChannelVersions,
    Checkpoint,
    CheckpointMetadata,
    CheckpointTuple,
)
from langgraph.checkpoint.memory import MemorySaver
from langgraph.config import RunnableConfig

logger = logging.getLogger(__name__)

# 后台执行器，用于异步同步到 Gateway（不阻塞 invoke 主流程）
_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="checkpoint-sync")


class D1Checkpointer(BaseCheckpointSaver):
    """
    双写 checkpointer：MemorySaver（同步）+ Gateway/D1（异步）

    重启后通过 Gateway 恢复 MemorySaver 状态，恢复对话连续性。
    """

    # 初始化当前对象
    def __init__(self, gateway_base_url: str = "", gateway_secret: str = ""):
        super().__init__()
        self._memory = MemorySaver()
        self._gateway_base_url = gateway_base_url
        self._gateway_secret = gateway_secret
        # 缓存已恢复的 thread_id，避免重复加载
        self._restored: set[str] = set()

    # ============ BaseCheckpointSaver 接口（同步） ============

    # 获取 get 对应的数据
    def get(self, config: RunnableConfig) -> Optional[dict[str, Any]]:
        """同步获取 checkpoint — 直接从 MemorySaver 读取"""
        return self._memory.get(config)

    # 更新或保存 put 对应的数据
    def put(
        self,
        config: RunnableConfig,
        checkpoint: Checkpoint,
        metadata: CheckpointMetadata,
        new_versions: ChannelVersions,
    ) -> RunnableConfig:
        """同步写入 checkpoint — MemorySaver 立即写入，Gateway 异步同步"""
        # 1. 同步写入 MemorySaver（主路径，不阻塞）
        new_config = self._memory.put(config, checkpoint, metadata, new_versions)

        # 2. 异步同步到 Gateway（后台线程，不阻塞 invoke）
        thread_id = (config.get("configurable") or {}).get("thread_id", "")
        if thread_id and self._gateway_base_url:
            try:
                loop = asyncio.get_event_loop()
                if loop.is_running():
                    # 在 async 上下文中，提交到后台线程池
                    _executor.submit(self._sync_to_gateway, thread_id, checkpoint, metadata, new_config)
                else:
                    # 在 sync 上下文中，直接运行
                    asyncio.run(self._async_sync(thread_id, checkpoint, metadata, new_config))
            except RuntimeError:
                # 无事件循环，使用后台线程
                _executor.submit(self._sync_to_gateway, thread_id, checkpoint, metadata, new_config)

        return new_config

    # 删除或清理 delete thread 对应的数据
    def delete_thread(self, thread_id: str) -> None:
        """同步删除线程的全部 checkpoint"""
        self._memory.delete_thread(thread_id)
        self._restored.discard(thread_id)

        # 异步删除 Gateway 中的数据
        if self._gateway_base_url:
            try:
                loop = asyncio.get_event_loop()
                if loop.is_running():
                    _executor.submit(self._delete_from_gateway, thread_id)
                else:
                    asyncio.run(self._async_delete(thread_id))
            except RuntimeError:
                _executor.submit(self._delete_from_gateway, thread_id)

    # 获取 list 对应的数据
    def list(
        self,
        config: Optional[RunnableConfig],
        *,
        filter: Optional[dict[str, Any]] = None,
        before: Optional[RunnableConfig] = None,
        limit: Optional[int] = None,
    ) -> Iterator[CheckpointTuple]:
        """列出 checkpoints"""
        return self._memory.list(config, filter=filter, before=before, limit=limit)

    # 获取 get tuple 对应的数据
    def get_tuple(self, config: RunnableConfig) -> Optional[CheckpointTuple]:
        """获取 checkpoint tuple"""
        return self._memory.get_tuple(config)

    # 更新或保存 put writes 对应的数据
    def put_writes(
        self,
        config: RunnableConfig,
        writes: Sequence[tuple[str, Any]],
        task_id: str,
        task_path: str = "",
    ) -> None:
        """批量写入 checkpoint writes"""
        self._memory.put_writes(config, writes, task_id, task_path)

    # 异步获取 checkpoint tuple
    async def aget_tuple(self, config: RunnableConfig) -> Optional[CheckpointTuple]:
        return await self._memory.aget_tuple(config)

    # 异步列出 checkpoints
    async def alist(
        self,
        config: Optional[RunnableConfig],
        *,
        filter: Optional[dict[str, Any]] = None,
        before: Optional[RunnableConfig] = None,
        limit: Optional[int] = None,
    ) -> AsyncIterator[CheckpointTuple]:
        async for checkpoint in self._memory.alist(
            config,
            filter=filter,
            before=before,
            limit=limit,
        ):
            yield checkpoint

    # 异步写入 checkpoint，并等待 Gateway 持久化完成
    async def aput(
        self,
        config: RunnableConfig,
        checkpoint: Checkpoint,
        metadata: CheckpointMetadata,
        new_versions: ChannelVersions,
    ) -> RunnableConfig:
        new_config = await self._memory.aput(config, checkpoint, metadata, new_versions)
        thread_id = (config.get("configurable") or {}).get("thread_id", "")
        if thread_id and self._gateway_base_url:
            await self._async_sync(thread_id, checkpoint, metadata, new_config)
        return new_config

    # 异步写入 checkpoint 的中间写入记录
    async def aput_writes(
        self,
        config: RunnableConfig,
        writes: Sequence[tuple[str, Any]],
        task_id: str,
        task_path: str = "",
    ) -> None:
        await self._memory.aput_writes(config, writes, task_id, task_path)

    # 异步删除线程的全部 checkpoint
    async def adelete_thread(self, thread_id: str) -> None:
        await self._memory.adelete_thread(thread_id)
        self._restored.discard(thread_id)
        if self._gateway_base_url:
            await self._async_delete(thread_id)

    # ============ 异步同步到 Gateway ============

    # 执行 sync to gateway 对应的业务逻辑
    def _sync_to_gateway(
        self,
        thread_id: str,
        checkpoint: Checkpoint,
        metadata: CheckpointMetadata,
        config: RunnableConfig,
    ) -> None:
        """在后台线程中异步同步到 Gateway"""
        try:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            loop.run_until_complete(
                self._async_sync(thread_id, checkpoint, metadata, config)
            )
        except Exception as exc:
            logger.warning("[checkpoint] Failed to sync to Gateway: %s", exc)
        finally:
            loop.close()

    # 执行 async sync 对应的业务逻辑
    async def _async_sync(
        self,
        thread_id: str,
        checkpoint: Checkpoint,
        metadata: CheckpointMetadata,
        config: RunnableConfig,
    ) -> None:
        """异步 POST checkpoint 到 Gateway"""
        try:
            import httpx

            checkpoint_id = checkpoint.get("id", f"ckpt_{datetime.now(UTC).isoformat()}")
            checkpoint_type, checkpoint_bytes = self.serde.dumps_typed(checkpoint)
            metadata_type, metadata_bytes = self.serde.dumps_typed(metadata)

            async with httpx.AsyncClient(
                base_url=self._gateway_base_url,
                headers={
                    "Authorization": f"Bearer {self._gateway_secret}",
                    "Content-Type": "application/json",
                },
                timeout=5.0,
            ) as client:
                response = await client.post(
                    f"/internal/v1/checkpoints/{thread_id}",
                    json={
                        "checkpoint_id": checkpoint_id,
                        "checkpoint_data": {
                            "serialization": checkpoint_type,
                            "payload_base64": base64.b64encode(checkpoint_bytes).decode("ascii"),
                        },
                        "metadata": {
                            "serialization": metadata_type,
                            "payload_base64": base64.b64encode(metadata_bytes).decode("ascii"),
                        },
                    },
                )
                response.raise_for_status()
        except Exception as exc:
            logger.warning("[checkpoint] Async sync to Gateway failed: %s", exc)

    # 执行 delete from gateway 对应的业务逻辑
    def _delete_from_gateway(self, thread_id: str) -> None:
        """在后台线程中异步删除 Gateway 中的 checkpoint"""
        try:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            loop.run_until_complete(self._async_delete(thread_id))
        except Exception as exc:
            logger.warning("[checkpoint] Failed to delete from Gateway: %s", exc)
        finally:
            loop.close()

    # 执行 async delete 对应的业务逻辑
    async def _async_delete(self, thread_id: str) -> None:
        """异步 DELETE checkpoint 从 Gateway"""
        try:
            import httpx

            async with httpx.AsyncClient(
                base_url=self._gateway_base_url,
                headers={
                    "Authorization": f"Bearer {self._gateway_secret}",
                    "Content-Type": "application/json",
                },
                timeout=5.0,
            ) as client:
                response = await client.delete(
                    f"/internal/v1/checkpoints/{thread_id}"
                )
                response.raise_for_status()
        except Exception as exc:
            logger.warning("[checkpoint] Async delete from Gateway failed: %s", exc)

    # ============ 从 Gateway 恢复 checkpoint ============

    # 执行 restore from gateway 对应的业务逻辑
    async def restore_from_gateway(self, thread_id: str) -> bool:
        """从 Gateway 加载最新 checkpoint 到 MemorySaver"""
        if thread_id in self._restored:
            return True

        try:
            import httpx

            async with httpx.AsyncClient(
                base_url=self._gateway_base_url,
                headers={
                    "Authorization": f"Bearer {self._gateway_secret}",
                    "Content-Type": "application/json",
                },
                timeout=5.0,
            ) as client:
                response = await client.get(
                    f"/internal/v1/checkpoints/{thread_id}"
                )
                if response.status_code == 404:
                    logger.debug("[checkpoint] No checkpoint found for thread %s", thread_id)
                    self._restored.add(thread_id)
                    return False

                response.raise_for_status()
                data = response.json().get("data", {})

                checkpoint_data = data.get("checkpoint_data", {})
                metadata = data.get("metadata", {})

                if "serialization" in checkpoint_data and "payload_base64" in checkpoint_data:
                    checkpoint_data = self.serde.loads_typed(
                        (
                            checkpoint_data["serialization"],
                            base64.b64decode(checkpoint_data["payload_base64"]),
                        )
                    )
                if "serialization" in metadata and "payload_base64" in metadata:
                    metadata = self.serde.loads_typed(
                        (
                            metadata["serialization"],
                            base64.b64decode(metadata["payload_base64"]),
                        )
                    )

                # 恢复到 MemorySaver
                config: RunnableConfig = {
                    "configurable": {"thread_id": thread_id}
                }
                self._memory.put(
                    config,
                    checkpoint_data,
                    metadata,
                    checkpoint_data.get("channel_versions", {}),
                )
                self._restored.add(thread_id)

                logger.info("[checkpoint] Restored checkpoint for thread %s", thread_id)
                return True

        except Exception as exc:
            logger.warning("[checkpoint] Failed to restore from Gateway: %s", exc)
            return False

    # 校验并判断 is restored 对应的状态
    def is_restored(self, thread_id: str) -> bool:
        """检查线程是否已从 Gateway 恢复"""
        return thread_id in self._restored
