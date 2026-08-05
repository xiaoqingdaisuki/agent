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
    importance: int = 3  # 1-5, 越高越重要
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


# 数据模型已迁移到 Cloudflare Service，本文件仅保留类型定义（UserProfile, Memory, QARecord）。
# ProfileStore 内存存储已移除。
