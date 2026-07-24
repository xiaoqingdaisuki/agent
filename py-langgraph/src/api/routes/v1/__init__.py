"""
External API v1 — 给前端 UI 使用
"""

from datetime import datetime
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from src.services import (
    AgentService,
    BusinessError,
    BusinessErrorCode,
    Capabilities,
    ConversationService,
    KnowledgeService,
    Message,
)

router = APIRouter()


# ============ 请求/响应模型 ============

class CreateConversationRequest(BaseModel):
    title: str = Field(..., min_length=1, max_length=100)
    mode: str = Field(default="chat", pattern="^(chat|knowledge|mixed)$")


class SendMessageRequest(BaseModel):
    content: str = Field(..., min_length=1)
    user_id: str | None = Field(None, description="用户标识，用于记忆和个人化")


class MessageResponse(BaseModel):
    id: str
    role: str
    content: str
    created_at: str


class ConversationResponse(BaseModel):
    id: str
    title: str
    mode: str
    created_at: str
    message_count: int


class DocumentResponse(BaseModel):
    id: str
    name: str
    size: int
    status: str
    chunks: int
    category: str | None = None
    created_at: str


class SearchRequest(BaseModel):
    query: str = Field(..., min_length=1)
    top_k: int = Field(default=5, ge=1, le=20)


# ============ 健康检查 ==========

@router.get("/health")
async def health():
    return {
        "status": "ok",
        "version": "0.2.0",
        "timestamp": datetime.now().isoformat(),
    }


# ============ 会话管理 ==========

@router.post("/conversations", response_model=ConversationResponse, status_code=201)
async def create_conversation(req: CreateConversationRequest):
    try:
        conv = ConversationService.create(req.title, req.mode)
        return conv.to_dict()
    except Exception:
        raise HTTPException(
            status_code=500,
            detail={"code": BusinessErrorCode.INTERNAL_ERROR.value, "message": "创建会话失败"},
        )


@router.get("/conversations")
async def list_conversations():
    return ConversationService.list()


@router.get("/conversations/{conv_id}")
async def get_conversation(conv_id: str):
    conv = ConversationService.get(conv_id)
    if not conv:
        raise HTTPException(
            status_code=404,
            detail={"code": BusinessErrorCode.NOT_FOUND.value, "message": "会话不存在"},
        )
    return conv.to_dict()


@router.delete("/conversations/{conv_id}")
async def delete_conversation(conv_id: str):
    deleted = ConversationService.delete(conv_id)
    if not deleted:
        raise HTTPException(
            status_code=404,
            detail={"code": BusinessErrorCode.NOT_FOUND.value, "message": "会话不存在"},
        )
    return {"success": True}


@router.get("/conversations/{conv_id}/messages")
async def get_messages(conv_id: str):
    conv = ConversationService.get(conv_id)
    if not conv:
        raise HTTPException(
            status_code=404,
            detail={"code": BusinessErrorCode.NOT_FOUND.value, "message": "会话不存在"},
        )
    return []


@router.post("/conversations/{conv_id}/messages", response_model=MessageResponse)
async def send_message(conv_id: str, req: SendMessageRequest):
    try:
        conv = ConversationService.get(conv_id)
        if not conv:
            raise HTTPException(
                status_code=404,
                detail={"code": BusinessErrorCode.NOT_FOUND.value, "message": "会话不存在"},
            )

        ConversationService.append_user_message(conv_id, req.content)
        reply = await AgentService.chat(conv_id, req.content, user_id=req.user_id)

        return reply.to_dict()
    except BusinessError as e:
        raise HTTPException(status_code=e.status_code, detail=e.to_dict())
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(
            status_code=500,
            detail={"code": BusinessErrorCode.INTERNAL_ERROR.value, "message": "发送消息失败"},
        )


@router.delete("/conversations/{conv_id}/messages")
async def clear_messages(conv_id: str):
    conv = ConversationService.get(conv_id)
    if not conv:
        raise HTTPException(
            status_code=404,
            detail={"code": BusinessErrorCode.NOT_FOUND.value, "message": "会话不存在"},
        )
    return {"success": True}


# ============ 知识库管理 ==========

@router.post("/knowledge/documents", response_model=DocumentResponse, status_code=201)
async def upload_document(request: Request):
    """上传文档（multipart/form-data）"""
    try:
        form = await request.form()
        file = form.get("file")
        category = form.get("category", "")

        if not file:
            raise HTTPException(
                status_code=400,
                detail={"code": BusinessErrorCode.INVALID_REQUEST.value, "message": "file is required"},
            )

        from fastapi import UploadFile

        from src.services import KnowledgeService

        if hasattr(file, "read"):
            content = await file.read()
            filename = file.filename or "unknown"
        else:
            raise HTTPException(
                status_code=400,
                detail={"code": BusinessErrorCode.INVALID_REQUEST.value, "message": "invalid file"},
            )

        doc = await KnowledgeService.upload_document(content, filename, category or None)
        return doc.to_dict()

    except BusinessError as e:
        raise HTTPException(status_code=e.status_code, detail=e.to_dict())
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail={"code": BusinessErrorCode.INTERNAL_ERROR.value, "message": f"文档上传失败: {e!s}"},
        )


@router.get("/knowledge/documents")
async def list_documents():
    return KnowledgeService.list_documents()


@router.get("/knowledge/documents/{doc_id}")
async def get_document(doc_id: str):
    doc = KnowledgeService.get_document(doc_id)
    if not doc:
        raise HTTPException(
            status_code=404,
            detail={"code": BusinessErrorCode.NOT_FOUND.value, "message": "文档不存在"},
        )
    return doc.to_dict()


@router.delete("/knowledge/documents/{doc_id}")
async def delete_document(doc_id: str):
    deleted = KnowledgeService.delete_document(doc_id)
    if not deleted:
        raise HTTPException(
            status_code=404,
            detail={"code": BusinessErrorCode.NOT_FOUND.value, "message": "文档不存在"},
        )
    return {"success": True}


@router.post("/knowledge/documents/{doc_id}/reindex")
async def reindex_document(doc_id: str):
    try:
        doc = await KnowledgeService.reindex_document(doc_id)
        return doc.to_dict()
    except BusinessError as e:
        raise HTTPException(status_code=e.status_code, detail=e.to_dict())
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(
            status_code=500,
            detail={"code": BusinessErrorCode.INTERNAL_ERROR.value, "message": "重新索引失败"},
        )


@router.post("/knowledge/search")
async def search_knowledge(req: SearchRequest):
    try:
        results = await KnowledgeService.search(req.query, req.top_k)
        return {"results": results}
    except BusinessError as e:
        raise HTTPException(status_code=e.status_code, detail=e.to_dict())
    except Exception:
        raise HTTPException(
            status_code=500,
            detail={"code": BusinessErrorCode.INTERNAL_ERROR.value, "message": "检索失败"},
        )


# ============ 能力查询 ==========

@router.get("/capabilities")
async def get_capabilities():
    return Capabilities.get()


# ============ 用户画像 + 记忆 + 历史 ==========

class ProfileQuery(BaseModel):
    user_id: str
    name: str = ""


@router.get("/profile")
async def get_profile(user_id: str, name: str = ""):
    try:
        from src.profile.service import ProfileService
        profile = ProfileService.get_or_create(user_id, name)
        return profile.to_dict()
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail={"code": BusinessErrorCode.INTERNAL_ERROR.value, "message": f"获取用户画像失败: {e!s}"},
        )


class ProfileUpdate(BaseModel):
    name: str = None
    preferences: dict = None


@router.patch("/profile")
async def update_profile(user_id: str, update: ProfileUpdate):
    try:
        from src.profile.service import ProfileService
        updates = {}
        if update.name is not None:
            updates["name"] = update.name
        if update.preferences is not None:
            updates["preferences"] = update.preferences
        profile = ProfileService.update(user_id, **updates)
        if not profile:
            raise HTTPException(
                status_code=404,
                detail={"code": BusinessErrorCode.NOT_FOUND.value, "message": "用户画像不存在"},
            )
        return profile.to_dict()
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail={"code": BusinessErrorCode.INTERNAL_ERROR.value, "message": f"更新用户画像失败: {e!s}"},
        )


@router.get("/memory")
async def get_memories(user_id: str, category: str = None):
    try:
        from src.profile.service import MemoryService
        memories = MemoryService.list_all(user_id)
        if category:
            memories = [m for m in memories if m["category"] == category]
        return {"memories": memories}
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail={"code": BusinessErrorCode.INTERNAL_ERROR.value, "message": f"获取记忆失败: {e!s}"},
        )


class MemoryCreate(BaseModel):
    content: str = Field(..., min_length=1)
    category: str = Field(default="fact", pattern="^(preference|fact|decision|context)$")
    importance: int = Field(default=3, ge=1, le=5)


@router.post("/memory", status_code=201)
async def create_memory(user_id: str, memory: MemoryCreate):
    try:
        from src.profile.service import MemoryService
        mem = MemoryService.add(user_id, memory.content, memory.category, memory.importance)
        return mem.to_dict()
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail={"code": BusinessErrorCode.INTERNAL_ERROR.value, "message": f"添加记忆失败: {e!s}"},
        )


@router.delete("/memory")
async def delete_memory(user_id: str, memory_id: str):
    try:
        from src.profile.service import MemoryService
        deleted = MemoryService.delete(user_id, memory_id)
        if not deleted:
            raise HTTPException(
                status_code=404,
                detail={"code": BusinessErrorCode.NOT_FOUND.value, "message": "记忆不存在"},
            )
        return {"success": True}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail={"code": BusinessErrorCode.INTERNAL_ERROR.value, "message": f"删除记忆失败: {e!s}"},
        )


@router.get("/history")
async def get_history(user_id: str, conversation_id: str = None, limit: int = 50):
    try:
        from src.profile.service import HistoryService
        records = HistoryService.get_history(user_id, conversation_id, limit)
        return {"history": records}
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail={"code": BusinessErrorCode.INTERNAL_ERROR.value, "message": f"获取历史记录失败: {e!s}"},
        )