"""
User Profile + Memory + History 数据模型

用户画像：用户基本信息与偏好
长期记忆：Agent 记住的关于用户的事实
问答记录：历史对话记录
"""

from dataclasses import dataclass, field
from datetime import datetime

# ============ 用户画像 ============


@dataclass
class UserProfile:
    """用户画像"""

    id: str
    name: str = ""
    preferences: dict = field(default_factory=dict)
    # 创建画像实例时记录当前创建时间
    created_at: str = field(default_factory=lambda: datetime.now().isoformat())
    # 创建画像实例时记录最近活跃时间
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


# ============ 长期记忆 ============


@dataclass
class Memory:
    """长期记忆 — Agent 记住的关于用户的事实"""

    id: str
    user_id: str
    content: str
    category: str = "fact"  # 记忆类别：preference、fact、decision 或 context
    importance: int = 3  # 1-5, 越高越重要
    # 创建记忆实例时记录当前创建时间
    created_at: str = field(default_factory=lambda: datetime.now().isoformat())
    # 创建记忆实例时记录当前更新时间
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


# ============ 问答历史 ============


@dataclass
class QARecord:
    """问答记录"""

    id: str
    user_id: str
    conversation_id: str
    question: str
    answer: str
    # 创建问答记录时生成当前时间戳
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


# 数据模型已迁移到 Cloudflare Service，本文件仅保留类型定义（UserProfile, Memory, QARecord）
# ProfileStore 内存存储已移除
