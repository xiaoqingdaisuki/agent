"""
External API v1 — 给前端 UI 使用
"""

import json
import asyncio
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from src.api.auth import require_agent_user_id
from src.api.request_logging import log_request_error
from src.api.sse import encode_sse_done, encode_sse_event
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
    user_id: str | None = Field(None, description="用户标识")


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
# 执行 health 对应的业务逻辑
async def health():
    return {
        "status": "ok",
        "version": "0.2.0",
        "timestamp": datetime.now().isoformat(),
    }


# ============ 会话管理 ==========


@router.post("/conversations", response_model=ConversationResponse, status_code=201)
# 创建新会话
async def create_conversation(req: CreateConversationRequest, request: Request):
    trusted_user_id = require_agent_user_id(request, req.user_id)
    try:
        conv = ConversationService.create(req.title, req.mode, trusted_user_id)
        return conv.to_dict()
    except Exception:
        raise HTTPException(
            status_code=500,
            detail={"code": BusinessErrorCode.INTERNAL_ERROR.value, "message": "创建会话失败"},
        )


@router.get("/conversations")
# 列出所有会话
async def list_conversations(request: Request, user_id: str = None):
    trusted_user_id = require_agent_user_id(request, user_id)
    return ConversationService.list(trusted_user_id)


@router.get("/conversations/{conv_id}")
# 获取指定会话详情
async def get_conversation(conv_id: str, request: Request):
    conv = ConversationService.get(conv_id)
    if not conv:
        raise HTTPException(
            status_code=404,
            detail={"code": BusinessErrorCode.NOT_FOUND.value, "message": "会话不存在"},
        )
    require_agent_user_id(request, conv.user_id)
    return conv.to_dict()


@router.delete("/conversations/{conv_id}")
# 删除指定会话及其消息
async def delete_conversation(conv_id: str, request: Request):
    conversation = ConversationService.get(conv_id)
    if not conversation:
        raise HTTPException(
            status_code=404,
            detail={"code": BusinessErrorCode.NOT_FOUND.value, "message": "会话不存在"},
        )
    require_agent_user_id(request, conversation.user_id)
    deleted = ConversationService.delete(conv_id)
    if not deleted:
        raise HTTPException(
            status_code=404,
            detail={"code": BusinessErrorCode.NOT_FOUND.value, "message": "会话不存在"},
        )
    from src.memory import get_default_checkpointer
    from src.commands import get_dark_mode_thread_id

    await get_default_checkpointer().adelete_thread(conv_id)
    await get_default_checkpointer().adelete_thread(get_dark_mode_thread_id(conv_id))
    return {"success": True}


@router.get("/conversations/{conv_id}/messages")
# 获取指定会话的消息列表
async def get_messages(conv_id: str, request: Request):
    conv = ConversationService.get(conv_id)
    if not conv:
        raise HTTPException(
            status_code=404,
            detail={"code": BusinessErrorCode.NOT_FOUND.value, "message": "会话不存在"},
        )
    require_agent_user_id(request, conv.user_id)
    return ConversationService.get_messages(conv_id)


@router.post("/conversations/{conv_id}/messages", response_model=MessageResponse)
# 向会话发送用户消息并获取 AI 回复
async def send_message(conv_id: str, req: SendMessageRequest, request: Request):
    trusted_user_id = require_agent_user_id(request, req.user_id)
    try:
        # 确保会话存在于 D1
        ConversationService.ensure(conv_id, trusted_user_id)

        conv = ConversationService.get(conv_id)
        if not conv:
            raise HTTPException(
                status_code=404,
                detail={"code": BusinessErrorCode.NOT_FOUND.value, "message": "会话不存在"},
            )

        # 从 Gateway 恢复 checkpoint（重启后恢复图状态）
        try:
            from src.memory import get_default_checkpointer
            await get_default_checkpointer().restore_from_gateway(conv_id)
        except Exception:
            pass  # 恢复失败不影响主流程

        ConversationService.append_user_message(conv_id, req.content, trusted_user_id)
        reply = await AgentService.chat(conv_id, req.content, user_id=trusted_user_id)

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


@router.post("/conversations/{conv_id}/messages/stream")
# 向会话发送消息并流式返回 AI 回复
async def stream_message(conv_id: str, req: SendMessageRequest, request: Request):
    trusted_user_id = require_agent_user_id(request, req.user_id)
    # 确保会话记录存在于 D1（前端可能直接请求已有的 thread_id）
    ConversationService.ensure(conv_id, trusted_user_id)

    conversation = ConversationService.get(conv_id)
    if not conversation:
        raise HTTPException(
            status_code=404,
            detail={"code": BusinessErrorCode.NOT_FOUND.value, "message": "会话不存在"},
        )

    # 从 Gateway 恢复 checkpoint（重启后恢复图状态）
    try:
        from src.memory import get_default_checkpointer
        await get_default_checkpointer().restore_from_gateway(conv_id)
    except Exception:
        pass  # 恢复失败不影响主流程

    ConversationService.append_user_message(conv_id, req.content, trusted_user_id)

    # 执行 event generator 对应的业务逻辑
    async def event_generator():
        yield encode_sse_event("meta", {"conversation_id": conv_id})
        try:
            async for event in AgentService.chat_stream(
                conv_id, req.content, user_id=trusted_user_id
            ):
                if await request.is_disconnected():
                    return
                payload = json.dumps(
                    {"delta": event["text"]}
                    if event["type"] == "text"
                    else {
                        "event": "tool",
                        "tool_name": event["tool_name"],
                        "status": event["status"],
                        "call_id": event["call_id"],
                    },
                    ensure_ascii=False,
                )
                yield encode_sse_event(
                    "text" if event["type"] == "text" else "tool",
                    json.loads(payload),
                )
        except BusinessError as error:
            log_request_error(
                request,
                error,
                {"conversation_id": conv_id, "user_id": trusted_user_id, "stream": True},
            )
            yield encode_sse_event(
                "error", {"ok": False, "error": error.to_dict().get("error", error.to_dict())}
            )
        except asyncio.CancelledError:
            log_request_error(
                request,
                RuntimeError("Client disconnected"),
                {"conversation_id": conv_id, "user_id": trusted_user_id, "stream": True},
            )
            raise
        except Exception as error:
            log_request_error(
                request, error, {"conversation_id": conv_id, "user_id": trusted_user_id, "stream": True}
            )
            yield encode_sse_event(
                "error",
                {"ok": False, "error": {"code": "INTERNAL_ERROR", "message": "处理请求时发生错误"}},
            )
        yield encode_sse_done()

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"},
    )


@router.delete("/conversations/{conv_id}/messages")
# 清空指定会话的全部消息
async def clear_messages(conv_id: str, request: Request):
    conv = ConversationService.get(conv_id)
    if not conv:
        raise HTTPException(
            status_code=404,
            detail={"code": BusinessErrorCode.NOT_FOUND.value, "message": "会话不存在"},
        )
    require_agent_user_id(request, conv.user_id)
    ConversationService.clear_messages(conv_id)
    from src.memory import get_default_checkpointer
    from src.commands import get_dark_mode_thread_id

    await get_default_checkpointer().adelete_thread(conv_id)
    await get_default_checkpointer().adelete_thread(get_dark_mode_thread_id(conv_id))
    return {"success": True}


# ============ 知识库管理 ==========


@router.post("/knowledge/documents", response_model=DocumentResponse, status_code=201)
# 上传文档并自动索引到向量库
async def upload_document(request: Request):
    """上传文档（multipart/form-data）"""
    try:
        form = await request.form()
        file = form.get("file")
        category = form.get("category", "")

        if not file:
            raise HTTPException(
                status_code=400,
                detail={
                    "code": BusinessErrorCode.INVALID_REQUEST.value,
                    "message": "file is required",
                },
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
            detail={
                "code": BusinessErrorCode.INTERNAL_ERROR.value,
                "message": f"文档上传失败: {e!s}",
            },
        )


@router.get("/knowledge/documents")
# 列出所有已索引文档
async def list_documents():
    return await KnowledgeService.list_documents()


@router.get("/knowledge/documents/{doc_id}")
# 获取指定文档详情
async def get_document(doc_id: str):
    doc = await KnowledgeService.get_document(doc_id)
    if not doc:
        raise HTTPException(
            status_code=404,
            detail={"code": BusinessErrorCode.NOT_FOUND.value, "message": "文档不存在"},
        )
    return doc.to_dict()


@router.delete("/knowledge/documents/{doc_id}")
# 删除指定文档及其向量索引
async def delete_document(doc_id: str):
    deleted = await KnowledgeService.delete_document(doc_id)
    if not deleted:
        raise HTTPException(
            status_code=404,
            detail={"code": BusinessErrorCode.NOT_FOUND.value, "message": "文档不存在"},
        )
    return {"success": True}


@router.post("/knowledge/documents/{doc_id}/reindex")
# 重新索引指定文档
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
# 在知识库中搜索相关内容
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
# 获取系统能力描述
async def get_capabilities():
    return Capabilities.get()


# ============ 用户画像 + 记忆 + 历史 ==========


class ProfileQuery(BaseModel):
    user_id: str
    name: str = ""


@router.get("/profile")
# 获取指定用户的画像信息
async def get_profile(request: Request, user_id: str = None, name: str = ""):
    trusted_user_id = require_agent_user_id(request, user_id)
    try:
        from src.profile.service import ProfileService

        profile = ProfileService.get_or_create(trusted_user_id, name)
        return profile.to_dict()
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail={
                "code": BusinessErrorCode.INTERNAL_ERROR.value,
                "message": f"获取用户画像失败: {e!s}",
            },
        )


class ProfileUpdate(BaseModel):
    name: str = None
    preferences: dict = None


@router.patch("/profile")
# 更新指定用户的画像信息
async def update_profile(request: Request, update: ProfileUpdate, user_id: str = None):
    trusted_user_id = require_agent_user_id(request, user_id)
    try:
        from src.profile.service import ProfileService

        updates = {}
        if update.name is not None:
            updates["name"] = update.name
        if update.preferences is not None:
            updates["preferences"] = update.preferences
        profile = ProfileService.update(trusted_user_id, **updates)
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
            detail={
                "code": BusinessErrorCode.INTERNAL_ERROR.value,
                "message": f"更新用户画像失败: {e!s}",
            },
        )


@router.get("/memory")
# 获取指定用户的记忆列表
async def get_memories(request: Request, user_id: str = None, category: str = None):
    trusted_user_id = require_agent_user_id(request, user_id)
    try:
        from src.profile.service import MemoryService

        memories = MemoryService.list_all(trusted_user_id)
        if category:
            memories = [m for m in memories if m["category"] == category]
        return {"memories": memories}
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail={
                "code": BusinessErrorCode.INTERNAL_ERROR.value,
                "message": f"获取记忆失败: {e!s}",
            },
        )


class MemoryCreate(BaseModel):
    content: str = Field(..., min_length=1)
    category: str = Field(default="fact", pattern="^(preference|fact|decision|context)$")
    importance: int = Field(default=3, ge=1, le=5)


@router.post("/memory", status_code=201)
# 为指定用户添加一条新记忆
async def create_memory(request: Request, memory: MemoryCreate, user_id: str = None):
    trusted_user_id = require_agent_user_id(request, user_id)
    try:
        from src.profile.service import MemoryService

        mem = MemoryService.add(
            trusted_user_id, memory.content, memory.category, memory.importance
        )
        return mem.to_dict()
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail={
                "code": BusinessErrorCode.INTERNAL_ERROR.value,
                "message": f"添加记忆失败: {e!s}",
            },
        )


@router.delete("/memory")
# 删除指定用户的记忆
async def delete_memory(request: Request, memory_id: str, user_id: str = None):
    trusted_user_id = require_agent_user_id(request, user_id)
    try:
        from src.profile.service import MemoryService

        deleted = MemoryService.delete(trusted_user_id, memory_id)
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
            detail={
                "code": BusinessErrorCode.INTERNAL_ERROR.value,
                "message": f"删除记忆失败: {e!s}",
            },
        )


@router.get("/history")
# 获取指定用户的问答历史记录
async def get_history(
    request: Request,
    user_id: str = None,
    conversation_id: str = None,
    limit: int = 50,
):
    trusted_user_id = require_agent_user_id(request, user_id)
    try:
        from src.profile.service import HistoryService

        records = HistoryService.get_history(trusted_user_id, conversation_id, limit)
        return {"history": records}
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail={
                "code": BusinessErrorCode.INTERNAL_ERROR.value,
                "message": f"获取历史记录失败: {e!s}",
            },
        )
