"""
Memory / Checkpoint 存储

LangGraph 的 checkpointer 机制：
- 每次 invoke 自动保存状态到 checkpoint
- 支持对话暂停/恢复、回滚、多线程隔离
- 当前使用 D1Checkpointer：同步写入 MemorySaver + 异步持久化到 Gateway (D1)
- 重启后从 D1 恢复图状态，确保对话连续性
"""

from src.memory.d1_checkpointer import D1Checkpointer

# 默认使用 D1 checkpointer（持久化到 Gateway/D1）
_checkpointer: D1Checkpointer | None = None


def get_default_checkpointer() -> D1Checkpointer:
    """获取默认 checkpointer（单例）"""
    global _checkpointer
    if _checkpointer is None:
        from src.config.settings import settings

        _checkpointer = D1Checkpointer(
            gateway_base_url=settings.memory_gateway_base_url,
            gateway_secret=settings.memory_gateway_secret,
        )
    return _checkpointer


def get_memory_saver():
    """获取纯内存 checkpointer（用于不需要持久化的场景）"""
    from langgraph.checkpoint.memory import MemorySaver

    return MemorySaver()
