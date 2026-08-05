"""
Memory / Checkpoint 存储

LangGraph 的 checkpointer 机制：
- 每次 invoke 自动保存状态到 checkpoint
- 支持对话暂停/恢复、回滚、多线程隔离
- 当前仅使用 MemorySaver（纯内存），对话状态持久化由 Cloudflare Service (D1) 负责
"""

from langgraph.checkpoint.memory import MemorySaver


# 默认使用内存 checkpointer（无需外部依赖）
_default_checkpointer: MemorySaver | None = None


# 获取默认内存 checkpointer 单例
def get_default_checkpointer():
    """获取默认 checkpointer（单例）"""
    global _default_checkpointer
    if _default_checkpointer is None:
        _default_checkpointer = MemorySaver()
    return _default_checkpointer
