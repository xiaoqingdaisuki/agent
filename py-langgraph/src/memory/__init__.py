"""
Memory / Checkpoint 存储

LangGraph 的 checkpointer 机制：
- 每次 invoke 自动保存状态到 checkpoint
- 支持对话暂停/恢复、回滚、多线程隔离
- memory_enabled=false 时使用 MemorySaver，状态仅在当前进程有效
- memory_enabled=true 时使用 D1Checkpointer，异步持久化并支持重启恢复
"""

from src.memory.d1_checkpointer import D1Checkpointer

# 按配置复用 D1Checkpointer 或纯内存 MemorySaver。
_checkpointer: D1Checkpointer | None = None
_memory_saver = None


# 获取 get default checkpointer 对应的数据
def get_default_checkpointer() -> D1Checkpointer:
    """获取默认 checkpointer（单例）"""
    global _checkpointer
    from src.config.settings import settings
    if not settings.memory_enabled:
        return get_memory_saver()
    if _checkpointer is None:
        _checkpointer = D1Checkpointer(
            gateway_base_url=settings.memory_gateway_base_url,
            gateway_secret=settings.memory_gateway_secret,
        )
    return _checkpointer


# 获取 get memory saver 对应的数据
def get_memory_saver():
    """获取纯内存 checkpointer（用于不需要持久化的场景）"""
    global _memory_saver
    from langgraph.checkpoint.memory import MemorySaver

    if _memory_saver is None:
        _memory_saver = MemorySaver()
    return _memory_saver
