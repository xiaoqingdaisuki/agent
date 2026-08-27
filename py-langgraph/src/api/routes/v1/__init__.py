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

from src.api.auth import get_agent_tool_identity, require_agent_user_id
from src.api.request_logging import log_request_error
from src.api.sse import SseEventSequencer, encode_sse_heartbeat, with_sse_heartbeats
from src.services import (
    AgentService,
    BusinessError,
    BusinessErrorCode,
    Capabilities,
    ConversationService,
    KnowledgeService,
    Message,
    TurnService,
    wait_for_conversation_persistence,
)

router = APIRouter()


# ============ 请求/响应模型 ============


class CreateConversationRequest(BaseModel):
    title: str = Field(..., min_length=1, max_length=100)
    mode: str = Field(default="chat", pattern="^(chat|knowledge|mixed)$")
    user_id: str | None = Field(None, description="用户标识")


class SendMessageRequest(BaseModel):
    content: str = Field(..., min_length=1, max_length=16_000)
    user_id: str | None = Field(None, description="用户标识，用于记忆和个人化")
    client_message_id: str | None = Field(default=None, min_length=1, max_length=128)


class MessageResponse(BaseModel):
    id: str
    role: str
    content: str
    created_at: str
    turn_id: str


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
    query: str = Field(..., min_length=1, max_length=2_000)
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


@router.get("/health/live")
# 报告进程存活，不依赖外部服务。
async def live_health():
    return {"status": "ok", "live": True, "version": "0.2.0"}


@router.get("/health/ready")
# 报告关键依赖配置是否满足接流条件。
async def ready_health():
    from fastapi.responses import JSONResponse
    from src.api.health import get_readiness

    readiness = get_readiness()
    return JSONResponse(status_code=200 if readiness["ready"] else 503, content=readiness)


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
    await get_default_checkpointer().adelete_thread(conv_id)
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
    tool_identity = get_agent_tool_identity(request, req.user_id)
    active_turn_id = None
    try:
        # 确保会话存在于当前仓储并校验用户归属。
        ConversationService.ensure(conv_id, trusted_user_id)

        conv = ConversationService.get(conv_id)
        if not conv:
            raise HTTPException(
                status_code=404,
                detail={"code": BusinessErrorCode.NOT_FOUND.value, "message": "会话不存在"},
            )

        # 启用记忆网关时尝试恢复 checkpoint；本地模式会安全跳过。
        try:
            from src.memory import get_default_checkpointer
            await get_default_checkpointer().restore_from_gateway(conv_id)
        except Exception:
            pass  # 恢复失败不影响主流程

        turn, created = TurnService.begin(
            conv_id, trusted_user_id, req.content, req.client_message_id
        )
        if not created:
            completed = TurnService.completed_message(turn)
            if completed:
                return {**completed.to_dict(), "turn_id": turn["id"]}
            raise TurnService.duplicate_error(turn["status"])

        active_turn_id = turn["id"]
        reply = await AgentService.chat(conv_id, req.content, user_id=trusted_user_id, tool_identity=tool_identity)
        TurnService.complete(turn["id"], trusted_user_id, reply)
        active_turn_id = None

        return {**reply.to_dict(), "turn_id": turn["id"]}
    except BusinessError as e:
        if active_turn_id:
            try:
                TurnService.terminate(active_turn_id, trusted_user_id, False, e.code.value)
            except Exception:
                pass
        raise HTTPException(status_code=e.status_code, detail=e.to_dict())
    except HTTPException:
        raise
    except Exception:
        if active_turn_id:
            try:
                TurnService.terminate(active_turn_id, trusted_user_id, False, "INTERNAL_ERROR")
            except Exception:
                pass
        raise HTTPException(
            status_code=500,
            detail={"code": BusinessErrorCode.INTERNAL_ERROR.value, "message": "发送消息失败"},
        )


@router.post("/conversations/{conv_id}/messages/stream")
# 向会话发送消息并流式返回 AI 回复
async def stream_message(conv_id: str, req: SendMessageRequest, request: Request):
    trusted_user_id = require_agent_user_id(request, req.user_id)
    tool_identity = get_agent_tool_identity(request, req.user_id)
    # 确保会话存在于当前仓储并校验已有 thread_id 的用户归属。
    ConversationService.ensure(conv_id, trusted_user_id)

    conversation = ConversationService.get(conv_id)
    if not conversation:
        raise HTTPException(
            status_code=404,
            detail={"code": BusinessErrorCode.NOT_FOUND.value, "message": "会话不存在"},
        )

    # 启用记忆网关时尝试恢复 checkpoint；本地模式会安全跳过。
    try:
        from src.memory import get_default_checkpointer
        await get_default_checkpointer().restore_from_gateway(conv_id)
    except Exception:
        pass  # 恢复失败不影响主流程

    await wait_for_conversation_persistence(conv_id)
    turn, created = TurnService.begin(
        conv_id, trusted_user_id, req.content, req.client_message_id
    )
    completed = None if created else TurnService.completed_message(turn)
    if not created and not completed:
        error = TurnService.duplicate_error(turn["status"])
        raise HTTPException(status_code=error.status_code, detail=error.to_dict())
    # 执行 event generator 对应的业务逻辑
    async def event_generator():
        sse_events = SseEventSequencer(turn["id"])
        full_answer = ""
        turn_completed = completed is not None
        yield sse_events.event(
            "meta", {"conversation_id": conv_id, "thread_id": conv_id, "turn_id": turn["id"]}
        )
        try:
            if completed:
                yield sse_events.event(
                    "text",
                    {"delta": completed.content, "text": completed.content, "partial": False, "replayed": True},
                )
                yield sse_events.done()
                return
            events = AgentService.chat_stream(
                conv_id, req.content, user_id=trusted_user_id, tool_identity=tool_identity
            )
            async for event in with_sse_heartbeats(events):
                if await request.is_disconnected():
                    TurnService.terminate(turn["id"], trusted_user_id, True, "CLIENT_CANCELLED")
                    return
                if event is None:
                    yield encode_sse_heartbeat()
                    continue
                if event["type"] == "text":
                    full_answer += event["text"]
                    payload = json.dumps(
                        {
                            "delta": event["text"],
                            "text": event["text"],
                            "partial": event.get("partial", False),
                        },
                        ensure_ascii=False,
                    )
                    event_name = "text"
                elif event["type"] == "tool":
                    payload = json.dumps(
                        {
                            "event": "tool",
                            "tool_name": event["tool_name"],
                            "status": event["status"],
                            "call_id": event["call_id"],
                            "duration_ms": event.get("duration_ms"),
                        },
                        ensure_ascii=False,
                    )
                    event_name = "tool"
                else:
                    payload = json.dumps(
                        {
                            "state": event.get("state"),
                            "stop_reason": event.get("stop_reason"),
                            "react": event.get("react"),
                        },
                        ensure_ascii=False,
                    )
                    event_name = event.get("event", "agent")
                yield sse_events.event(
                    event_name,
                    json.loads(payload),
                )
            assistant = Message("assistant", full_answer)
            TurnService.complete(turn["id"], trusted_user_id, assistant)
            turn_completed = True
        except BusinessError as error:
            log_request_error(
                request,
                error,
                {"conversation_id": conv_id, "user_id": trusted_user_id, "stream": True},
            )
            yield sse_events.event(
                "error", {"ok": False, "error": error.to_dict().get("error", error.to_dict())}
            )
            if not turn_completed:
                try:
                    TurnService.terminate(turn["id"], trusted_user_id, False, error.code.value)
                except Exception:
                    pass
        except asyncio.CancelledError:
            if not turn_completed:
                try:
                    TurnService.terminate(turn["id"], trusted_user_id, True, "CLIENT_CANCELLED")
                except Exception:
                    pass
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
            yield sse_events.event(
                "error",
                {"ok": False, "error": {"code": "INTERNAL_ERROR", "message": "处理请求时发生错误"}},
            )
            if not turn_completed:
                try:
                    TurnService.terminate(turn["id"], trusted_user_id, False, "INTERNAL_ERROR")
                except Exception:
                    pass
        yield sse_events.done()

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
    await get_default_checkpointer().adelete_thread(conv_id)
    return {"success": True}


# ============ 知识库管理 ==========


@router.post("/knowledge/documents", response_model=DocumentResponse, status_code=201)
# 上传文档并自动索引到向量库
async def upload_document(request: Request):
    """上传文档（multipart/form-data）"""
    try:
        trusted_user_id = require_agent_user_id(request)
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

        doc = await KnowledgeService.upload_document(content, filename, category or None, trusted_user_id)
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
async def list_documents(request: Request):
    return await KnowledgeService.list_documents(require_agent_user_id(request))


@router.get("/knowledge/documents/{doc_id}")
# 获取指定文档详情
async def get_document(doc_id: str, request: Request):
    doc = await KnowledgeService.get_document(doc_id, require_agent_user_id(request))
    if not doc:
        raise HTTPException(
            status_code=404,
            detail={"code": BusinessErrorCode.NOT_FOUND.value, "message": "文档不存在"},
        )
    return doc.to_dict()


@router.delete("/knowledge/documents/{doc_id}")
# 删除指定文档及其向量索引
async def delete_document(doc_id: str, request: Request):
    deleted = await KnowledgeService.delete_document(doc_id, require_agent_user_id(request))
    if not deleted:
        raise HTTPException(
            status_code=404,
            detail={"code": BusinessErrorCode.NOT_FOUND.value, "message": "文档不存在"},
        )
    return {"success": True}


@router.post("/knowledge/documents/{doc_id}/reindex")
# 重新索引指定文档
async def reindex_document(doc_id: str, request: Request):
    try:
        doc = await KnowledgeService.reindex_document(doc_id, require_agent_user_id(request))
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
async def search_knowledge(req: SearchRequest, request: Request):
    try:
        results = await KnowledgeService.search(req.query, req.top_k, require_agent_user_id(request))
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
