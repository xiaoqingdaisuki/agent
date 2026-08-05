"""
Gateway 响应数据模型 Pydantic Schemas

与 cloudflare-service 的 src/schemas/memory-models.ts 保持一致。
用于运行时校验 Gateway 响应，确保数据不偏离契约。
"""

from enum import Enum
from typing import Optional

from pydantic import BaseModel, ConfigDict


class MemoryCategory(str, Enum):
    preference = "preference"
    fact = "fact"
    decision = "decision"
    context = "context"


class MemorySource(str, Enum):
    user_explicit = "user_explicit"
    conversation_extraction = "conversation_extraction"


class MemoryStatus(str, Enum):
    active = "active"
    deleted = "deleted"


class MemoryIndexStatus(str, Enum):
    pending = "pending"
    ready = "ready"
    failed = "failed"
    deleting = "deleting"


class ConversationMode(str, Enum):
    chat = "chat"
    knowledge = "knowledge"
    mixed = "mixed"


class MessageRole(str, Enum):
    user = "user"
    assistant = "assistant"
    system = "system"
    tool = "tool"


# ============ 数据模型 ============

class UserProfileData(BaseModel):
    user_id: str
    name: str = ""
    preferences_json: str = "{}"
    created_at: str
    updated_at: str

    model_config = ConfigDict(from_attributes=True)


class ConversationData(BaseModel):
    id: str
    user_id: str
    title: str = ""
    mode: ConversationMode = ConversationMode.chat
    created_at: str
    updated_at: str
    deleted_at: Optional[str] = None

    model_config = {"from_attributes": True}


class MessageData(BaseModel):
    id: str
    conversation_id: str
    user_id: str
    sequence_no: int
    role: MessageRole = MessageRole.user
    content_json: str
    created_at: str

    model_config = {"from_attributes": True}


class MemoryData(BaseModel):
    id: str
    user_id: str
    content: str
    normalized_content: str
    content_hash: str
    category: MemoryCategory
    importance: int = 3
    source: MemorySource = MemorySource.user_explicit
    source_conversation_id: Optional[str] = None
    status: MemoryStatus = MemoryStatus.active
    index_status: MemoryIndexStatus = MemoryIndexStatus.pending
    embedding_model: str
    embedding_version: int = 1
    created_at: str
    updated_at: str
    last_accessed_at: Optional[str] = None
    expires_at: Optional[str] = None

    model_config = {"from_attributes": True}


class MemorySearchResultData(BaseModel):
    id: str
    content: str
    category: MemoryCategory
    importance: int
    semantic_score: float
    final_score: float
    created_at: str
    updated_at: str

    model_config = {"from_attributes": True}


class MessagesPageData(BaseModel):
    messages: list[MessageData]
    total: int

    model_config = {"from_attributes": True}


class SearchResponseData(BaseModel):
    items: list[MemorySearchResultData]
    degraded: bool = False

    model_config = {"from_attributes": True}


# ============ 统一响应格式 ============

class GatewayErrorData(BaseModel):
    code: str
    message: str


class GatewayMetaData(BaseModel):
    request_id: str
    degraded: bool = False
    warnings: list[str] = []


class GatewayResponse(BaseModel):
    ok: bool
    data: Optional[object] = None
    error: Optional[GatewayErrorData] = None
    meta: GatewayMetaData

    model_config = {"from_attributes": True}
