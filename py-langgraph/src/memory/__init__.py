"""
Memory / Checkpoint 存储

LangGraph 的 checkpointer 机制：
- 每次 invoke 自动保存状态到 checkpoint
- 支持对话暂停/恢复、回滚、多线程隔离
- PostgresSaver: 生产环境（需要 Postgres）
- MemorySaver: 开发/测试环境（纯内存）
"""

from typing import Optional
from langgraph.checkpoint.memory import MemorySaver
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver


def get_checkpointer(checkpoint_type: str = "memory"):
    """
    根据配置获取 checkpointer

    Args:
        checkpoint_type: "memory" | "postgres"
    """
    if checkpoint_type == "postgres":
        from src.config.settings import settings
        return AsyncPostgresSaver.from_conn_string(
            settings.postgres_uri,
            pipeline=False,
        )
    return MemorySaver()


# 默认使用内存 checkpointer（无需外部依赖）
_default_checkpointer: Optional[MemorySaver] = None


def get_default_checkpointer():
    """获取默认 checkpointer（单例）"""
    global _default_checkpointer
    if _default_checkpointer is None:
        _default_checkpointer = MemorySaver()
    return _default_checkpointer
