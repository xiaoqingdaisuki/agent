"""
External API v1 — 给前端 UI 使用
"""

import json
import asyncio
import base64
import hashlib
from datetime import datetime
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from src.api.auth import get_agent_tool_identity, require_agent_user_id
from src.api.request_logging import log_request_error
from src.api.sse import SseEventSequencer, encode_sse_heartbeat, with_sse_heartbeats
from src.config.settings import settings
from src.services.document_parser import (
    DocumentParseError,
    SESSION_DOCUMENT_JSON_MAX_BYTES,
    parse_document,
)
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
    content: str = Field(default="", max_length=16_000)
    user_id: str | None = Field(None, description="用户标识，用于记忆和个人化")
    client_message_id: str | None = Field(default=None, min_length=1, max_length=128)
    session_documents: list[dict[str, Any]] = Field(default_factory=list)
    document_attachment_ids: list[str] = Field(default_factory=list, max_length=20)


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


# 将统一文档解析异常转换为 FastAPI 错误响应。
def document_parse_http_error(error: DocumentParseError) -> HTTPException:
    return HTTPException(
        status_code=error.status_code,
        detail={"code": BusinessErrorCode.INVALID_REQUEST.value, "message": str(error)},
    )


# 读取 JSON 或 multipart 消息，并将图片编码为仅当前请求使用的数据块。
async def read_send_message_payload(request: Request) -> tuple[SendMessageRequest, dict[str, Any]]:
    content_type = request.headers.get("content-type", "").lower()
    if "multipart/form-data" not in content_type:
        try:
            payload = await request.json()
            raw_documents = payload.get("session_documents") if isinstance(payload, dict) else None
            if raw_documents is not None and len(json.dumps(raw_documents, ensure_ascii=False).encode("utf-8")) > SESSION_DOCUMENT_JSON_MAX_BYTES:
                raise HTTPException(
                    status_code=413,
                    detail={
                        "code": BusinessErrorCode.INVALID_REQUEST.value,
                        "message": "临时文档总大小不能超过 5MB",
                    },
                )
            req = SendMessageRequest.model_validate(payload)
        except Exception as error:
            if isinstance(error, HTTPException):
                raise
            raise HTTPException(
                status_code=400,
                detail={"code": BusinessErrorCode.INVALID_REQUEST.value, "message": "请求体格式不正确"},
            ) from error
        return req, {
            "session_documents": req.session_documents,
            "document_ids": req.document_attachment_ids,
            "images": [],
        }

    form = await request.form()
    metadata: dict[str, Any] = {}
    raw_metadata = form.get("metadata")
    if isinstance(raw_metadata, str):
        try:
            parsed = json.loads(raw_metadata)
            if isinstance(parsed, dict):
                metadata = parsed
        except json.JSONDecodeError as error:
            raise HTTPException(
                status_code=400,
                detail={"code": BusinessErrorCode.INVALID_REQUEST.value, "message": "附件元数据格式不正确"},
            ) from error

    documents = list(metadata.get("session_documents") or [])
    images: list[dict[str, str]] = []
    image_fingerprints: set[str] = set()
    for field_name, value in form.multi_items():
        if field_name in {"metadata", "content", "user_id", "client_message_id"}:
            continue
        if not hasattr(value, "read"):
            continue
        file_content = await value.read()
        content_type_value = str(getattr(value, "content_type", "") or "")
        filename = str(getattr(value, "filename", "unknown") or "unknown")
        if content_type_value.startswith("image/"):
            fingerprint = hashlib.sha256(file_content).hexdigest()
            if fingerprint in image_fingerprints:
                continue
            image_fingerprints.add(fingerprint)
            if len(images) >= 4:
                raise HTTPException(
                    status_code=400,
                    detail={"code": BusinessErrorCode.INVALID_REQUEST.value, "message": "图片最多上传 4 张"},
                )
            images.append({
                "mime_type": content_type_value,
                "data": base64.b64encode(file_content).decode("ascii"),
                "filename": filename,
            })
        else:
            try:
                documents.append(parse_document(file_content, filename, content_type_value))
            except DocumentParseError as error:
                raise document_parse_http_error(error) from error

    req = SendMessageRequest.model_validate({
        "content": metadata.get("content", form.get("content", "")),
        "user_id": metadata.get("user_id", form.get("user_id")),
        "client_message_id": metadata.get("client_message_id", form.get("client_message_id")),
        "session_documents": documents,
        "document_attachment_ids": metadata.get("document_attachment_ids", []),
    })
    if len(json.dumps(documents, ensure_ascii=False).encode("utf-8")) > SESSION_DOCUMENT_JSON_MAX_BYTES:
        raise HTTPException(
            status_code=413,
            detail={
                "code": BusinessErrorCode.INVALID_REQUEST.value,
                "message": "临时文档总大小不能超过 5MB",
            },
        )
    return req, {
        "session_documents": documents,
        "document_ids": req.document_attachment_ids,
        "images": images,
    }


# 持久化模式将本轮文档写入知识库，关闭记忆模式只返回临时上下文。
async def prepare_attachment_context(attachments: dict[str, Any], user_id: str) -> dict[str, Any]:
    if not settings.memory_enabled or not attachments.get("session_documents"):
        return attachments
    document_ids = list(attachments.get("document_ids") or [])
    for document in attachments["session_documents"]:
        text = "\n\n".join(str(part.get("content") or "") for part in document.get("parts", []))
        uploaded = await KnowledgeService.upload_document(
            text.encode("utf-8"),
            str(document.get("filename") or "unknown.txt"),
            None,
            user_id,
            parsed_content=text,
        )
        document_ids.append(uploaded.id)
    return {**attachments, "document_ids": document_ids}


# 要求持久化知识库模式，避免关闭记忆时误写长期文档数据。
def require_persistent_knowledge() -> None:
    if not settings.memory_enabled:
        raise HTTPException(
            status_code=403,
            detail={
                "code": BusinessErrorCode.FORBIDDEN.value,
                "message": "memory_enabled=false 时不启用知识库持久化",
            },
        )


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
async def send_message(conv_id: str, request: Request):
    req, attachment_context = await read_send_message_payload(request)
    trusted_user_id = require_agent_user_id(request, req.user_id)
    tool_identity = get_agent_tool_identity(request, req.user_id)
    content = req.content.strip()
    has_attachment = bool(
        attachment_context.get("session_documents")
        or attachment_context.get("document_ids")
        or attachment_context.get("images")
    )
    if not content and not has_attachment:
        raise HTTPException(
            status_code=400,
            detail={"code": BusinessErrorCode.INVALID_REQUEST.value, "message": "content or attachment is required"},
        )
    turn_content = content or "请分析我上传的附件"
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
            conv_id, trusted_user_id, turn_content, req.client_message_id
        )
        if not created:
            completed = TurnService.completed_message(turn)
            if completed:
                return {**completed.to_dict(), "turn_id": turn["id"]}
            raise TurnService.duplicate_error(turn["status"])

        active_turn_id = turn["id"]
        attachment_context = await prepare_attachment_context(attachment_context, trusted_user_id)
        reply = await AgentService.chat(
            conv_id,
            turn_content,
            user_id=trusted_user_id,
            tool_identity=tool_identity,
            attachment_context=attachment_context,
        )
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
async def stream_message(conv_id: str, request: Request):
    req, attachment_context = await read_send_message_payload(request)
    trusted_user_id = require_agent_user_id(request, req.user_id)
    tool_identity = get_agent_tool_identity(request, req.user_id)
    content = req.content.strip()
    has_attachment = bool(
        attachment_context.get("session_documents")
        or attachment_context.get("document_ids")
        or attachment_context.get("images")
    )
    if not content and not has_attachment:
        raise HTTPException(
            status_code=400,
            detail={"code": BusinessErrorCode.INVALID_REQUEST.value, "message": "content or attachment is required"},
        )
    turn_content = content or "请分析我上传的附件"
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
        conv_id, trusted_user_id, turn_content, req.client_message_id
    )
    completed = None if created else TurnService.completed_message(turn)
    if not created and not completed:
        error = TurnService.duplicate_error(turn["status"])
        raise HTTPException(status_code=error.status_code, detail=error.to_dict())
    try:
        attachment_context = await prepare_attachment_context(attachment_context, trusted_user_id)
    except BusinessError as error:
        TurnService.terminate(turn["id"], trusted_user_id, False, error.code.value)
        raise HTTPException(status_code=error.status_code, detail=error.to_dict()) from error
    except Exception as error:
        TurnService.terminate(turn["id"], trusted_user_id, False, "INTERNAL_ERROR")
        raise HTTPException(
            status_code=500,
            detail={"code": BusinessErrorCode.INTERNAL_ERROR.value, "message": "附件处理失败"},
        ) from error
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
                conv_id,
                turn_content,
                user_id=trusted_user_id,
                tool_identity=tool_identity,
                attachment_context=attachment_context,
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
        require_persistent_knowledge()
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
    require_persistent_knowledge()
    return await KnowledgeService.list_documents(require_agent_user_id(request))


@router.get("/knowledge/documents/{doc_id}")
# 获取指定文档详情
async def get_document(doc_id: str, request: Request):
    require_persistent_knowledge()
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
    require_persistent_knowledge()
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
        require_persistent_knowledge()
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
        require_persistent_knowledge()
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
