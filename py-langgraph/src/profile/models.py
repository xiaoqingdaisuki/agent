"""
User Profile + Memory + History 数据模型

用户画像：用户基本信息与偏好
长期记忆：Agent 记住的关于用户的事实
问答记录：历史对话记录
"""

from dataclasses import dataclass, field
from datetime import datetime

# ============ User Profile ============

@dataclass
class UserProfile:
    """用户画像"""
    id: str
    name: str = ""
    preferences: dict = field(default_factory=dict)
    created_at: str = field(default_factory=lambda: datetime.now().isoformat())
    last_active_at: str = field(default_factory=lambda: datetime.now().isoformat())

    # 将用户画像序列化为字典
    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "preferences": self.preferences,
            "created_at": self.created_at,
            "last_active_at": self.last_active_at,
        }


# ============ Memory ============

@dataclass
class Memory:
    """长期记忆 — Agent 记住的关于用户的事实"""
    id: str
    user_id: str
    content: str
    category: str = "fact"  # preference | fact | decision | context
    importance: int = 3     # 1-5, 越高越重要
    created_at: str = field(default_factory=lambda: datetime.now().isoformat())
    updated_at: str = field(default_factory=lambda: datetime.now().isoformat())

    # 将记忆记录序列化为字典
    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "user_id": self.user_id,
            "content": self.content,
            "category": self.category,
            "importance": self.importance,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }


# ============ Q&A History ============

@dataclass
class QARecord:
    """问答记录"""
    id: str
    user_id: str
    conversation_id: str
    question: str
    answer: str
    timestamp: str = field(default_factory=lambda: datetime.now().isoformat())

    # 将问答记录序列化为字典
    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "user_id": self.user_id,
            "conversation_id": self.conversation_id,
            "question": self.question,
            "answer": self.answer,
            "timestamp": self.timestamp,
        }


# ============ Store ==========

class ProfileStore:
    """内存存储 — 可替换为数据库"""

    def __init__(self):
        self._profiles: dict[str, UserProfile] = {}
        self._memories: dict[str, list[Memory]] = {}  # user_id -> [Memory]
        self._qa_records: dict[str, list[QARecord]] = {}  # user_id -> [QARecord]

    # ---- Profile ----

    # 根据用户 ID 获取已有画像，不存在时返回 None
    def get_profile(self, user_id: str) -> UserProfile | None:
        return self._profiles.get(user_id)

    # 创建或覆盖用户画像
    def create_profile(self, profile: UserProfile) -> UserProfile:
        self._profiles[profile.id] = profile
        return profile

    # 更新用户画像字段
    def update_profile(self, user_id: str, **updates) -> UserProfile | None:
        profile = self._profiles.get(user_id)
        if not profile:
            return None
        for key, value in updates.items():
            if hasattr(profile, key):
                setattr(profile, key, value)
        profile.last_active_at = datetime.now().isoformat()
        return profile

    # ---- Memory ----

    # 添加一条记忆记录
    def add_memory(self, memory: Memory) -> Memory:
        if memory.user_id not in self._memories:
            self._memories[memory.user_id] = []
        self._memories[memory.user_id].append(memory)
        return memory

    # 获取用户的所有记忆，可按类别过滤并按重要性排序
    def get_memories(self, user_id: str, category: str = None) -> list[Memory]:
        memories = self._memories.get(user_id, [])
        if category:
            memories = [m for m in memories if m.category == category]
        return sorted(memories, key=lambda m: -m.importance)

    # 删除指定记忆，返回是否删除成功
    def delete_memory(self, user_id: str, memory_id: str) -> bool:
        memories = self._memories.get(user_id, [])
        for i, m in enumerate(memories):
            if m.id == memory_id:
                memories.pop(i)
                return True
        return False

    # ---- Q&A History ----

    # 添加一条问答记录
    def add_qa_record(self, record: QARecord) -> QARecord:
        if record.user_id not in self._qa_records:
            self._qa_records[record.user_id] = []
        self._qa_records[record.user_id].append(record)
        return record

    # 获取用户问答历史，支持按会话过滤和数量限制
    def get_qa_history(self, user_id: str, conversation_id: str = None, limit: int = 50) -> list[QARecord]:
        records = self._qa_records.get(user_id, [])
        if conversation_id:
            records = [r for r in records if r.conversation_id == conversation_id]
        return sorted(records, key=lambda r: r.timestamp)[-limit:]


# 全局单例
store = ProfileStore()
