"""
Profile Service — 用户画像 + 长期记忆 + 问答历史

统一通过 Repository 层访问 Cloudflare Service。
"""

from __future__ import annotations

import json
import re
import threading
from datetime import datetime
from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI

from src.profile.models import Memory, QARecord, UserProfile
from src.config.settings import settings
from src.repositories import get_repositories

# Repository 缓存（模块级变量，避免重复创建）
_repositories = None


def _get_repositories():
    """获取 Cloudflare 仓储实例"""
    global _repositories
    if _repositories is None:
        _repositories = get_repositories()
    return _repositories


class ProfileService:
    """用户画像管理"""

    @staticmethod
    def get_or_create(user_id: str, name: str = "") -> UserProfile:
        repos = _get_repositories()
        data = repos.get_or_create_profile(user_id, name)
        return UserProfile(
            id=data["user_id"],
            name=data.get("name", ""),
            preferences=json.loads(data.get("preferences_json", "{}")),
            created_at=data.get("created_at", ""),
            last_active_at=data.get("updated_at", ""),
        )

    @staticmethod
    def get(user_id: str) -> UserProfile | None:
        repos = _get_repositories()
        data = repos.get_profile(user_id)
        if not data:
            return None
        return UserProfile(
            id=data["user_id"],
            name=data.get("name", ""),
            preferences=json.loads(data.get("preferences_json", "{}")),
            created_at=data.get("created_at", ""),
            last_active_at=data.get("updated_at", ""),
        )

    @staticmethod
    def update(user_id: str, **updates) -> UserProfile | None:
        repos = _get_repositories()
        name = updates.get("name", "")
        preferences = updates.get("preferences")
        data = repos.update_profile(user_id, name=name, preferences=preferences)
        if not data:
            return None
        return UserProfile(
            id=data["user_id"],
            name=data.get("name", ""),
            preferences=json.loads(data.get("preferences_json", "{}")),
            created_at=data.get("created_at", ""),
            last_active_at=data.get("updated_at", ""),
        )


class MemoryService:
    """长期记忆管理"""

    @staticmethod
    def add(user_id: str, content: str, category: str = "fact", importance: int = 3) -> Memory:
        """存储一条新记忆"""
        repos = _get_repositories()
        data = repos.save_memory(user_id, content.strip(), category, importance)
        return Memory(
            id=data["id"],
            user_id=data["user_id"],
            content=data["content"],
            category=data["category"],
            importance=data["importance"],
            created_at=data.get("created_at", ""),
            updated_at=data.get("updated_at", ""),
        )

    @staticmethod
    def get_relevant(user_id: str, max_items: int = 10) -> list[Memory]:
        """获取用户的高优先级记忆"""
        repos = _get_repositories()
        data = repos.search_memories(user_id, "", category=None, limit=max_items)
        items = data.get("items", [])
        return [
            Memory(
                id=m["id"],
                user_id=user_id,
                content=m["content"],
                category=m["category"],
                importance=m["importance"],
                created_at=m.get("created_at", ""),
                updated_at=m.get("updated_at", ""),
            )
            for m in items[:max_items]
        ]

    @staticmethod
    def get_by_category(user_id: str, category: str) -> list[Memory]:
        repos = _get_repositories()
        data = repos.list_memories(user_id, category=category)
        return [
            Memory(
                id=m["id"],
                user_id=m["user_id"],
                content=m["content"],
                category=m["category"],
                importance=m["importance"],
                created_at=m.get("created_at", ""),
                updated_at=m.get("updated_at", ""),
            )
            for m in data
        ]

    @staticmethod
    def delete(user_id: str, memory_id: str) -> bool:
        repos = _get_repositories()
        return repos.delete_memory(memory_id)

    @staticmethod
    def list_all(user_id: str) -> list[dict]:
        repos = _get_repositories()
        return repos.list_memories(user_id)

    @staticmethod
    def build_memory_context(user_id: str) -> str:
        """将记忆组装成 prompt 片段，供注入 System Prompt"""
        memories = MemoryService.get_relevant(user_id, 10)
        if not memories:
            return ""

        lines = ["[我记住的关于你的事]"]
        for m in memories:
            lines.append(f"- {m.content}")
        lines.append("")
        return "\n".join(lines)

    @staticmethod
    def extract_memories_from_conversation(
        user_id: str, question: str, answer: str
    ) -> list[Memory]:
        """从对话中提取值得记忆的事实（正则 + LLM 双层提取）"""
        # 第一层：正则规则立即提取
        regex_memories = MemoryService._extract_with_regex(user_id, question)
        for mem in regex_memories:
            try:
                repos = _get_repositories()
                repos.save_memory(user_id, mem.content, mem.category, mem.importance)
            except Exception:
                pass

        # 第二层：LLM 异步提取（不阻塞主流程）
        if settings.memory_auto_extract:
            thread = threading.Thread(
                target=MemoryService._extract_with_llm,
                args=(user_id, question, answer),
                daemon=True,
            )
            thread.start()

        return regex_memories

    @staticmethod
    def _extract_with_regex(user_id: str, question: str) -> list[Memory]:
        """正则规则提取"""
        new_memories = []
        q = question.lower()

        preference_patterns = [
            (r"我喜欢(.+?)[。！\n]", "preference"),
            (r"我爱(.+?)[。！\n]", "preference"),
            (r"我讨厌(.+?)[。！\n]", "preference"),
            (r"别(.+?)[。！\n]", "preference"),
            (r"不要(.+?)[。！\n]", "preference"),
            (r"(.+?)是我喜欢的", "preference"),
        ]

        for pattern, category in preference_patterns:
            matches = re.findall(pattern, q)
            for match in matches:
                content = match.strip()
                if len(content) > 1 and len(content) < 50:
                    new_memories.append(
                        Memory(
                            id=f"mem_{datetime.now().strftime('%Y%m%d%H%M%S%f')}",
                            user_id=user_id,
                            content=f"用户喜欢/偏好: {content}",
                            category=category,
                            importance=4,
                        )
                    )

        info_patterns = [
            (r"我在(.+?)[。！\n]", "fact"),
            (r"我叫(.+?)[。！\n]", "fact"),
            (r"我是(.+?)[。！\n]", "fact"),
        ]

        for pattern, category in info_patterns:
            matches = re.findall(pattern, q)
            for match in matches:
                content = match.strip()
                if len(content) > 1 and len(content) < 50:
                    new_memories.append(
                        Memory(
                            id=f"mem_{datetime.now().strftime('%Y%m%d%H%M%S%f')}",
                            user_id=user_id,
                            content=f"用户信息: {content}",
                            category=category,
                            importance=5,
                        )
                    )

        return new_memories

    @staticmethod
    def _extract_with_llm(user_id: str, question: str, answer: str) -> None:
        """LLM-based 记忆提取"""
        if not settings.openai_api_key:
            return

        try:
            llm = ChatOpenAI(
                model=settings.openai_model,
                api_key=settings.openai_api_key,
                base_url=settings.openai_base_url,
            )

            prompt = (
                "你是一个记忆提取助手。分析以下对话，判断是否有值得长期记住的用户信息。\n\n"
                "规则：\n"
                "1. 只提取有长期价值的信息：偏好、习惯、个人信息（职业/所在地/家庭）、重要决定\n"
                "2. 不提取：临时性内容、闲聊、问候、已经知道的重复信息\n"
                "3. 每条记忆控制在 30 字以内，简洁明确\n"
                "4. 如果没有任何值得记住的信息，返回空数组\n"
                "5. 返回 JSON 数组，每项包含 category（preference/fact/decision/context）和 content 字段\n\n"
                f"用户问题：{question}\n"
                f"助手回答：{answer}\n\n"
                "JSON 输出（无其他内容）："
            )

            response = llm.invoke(
                [
                    SystemMessage(content="你只输出 JSON 数组，不输出其他内容。"),
                    HumanMessage(content=prompt),
                ]
            )
            text = response.content if isinstance(response.content, str) else ""

            json_match = re.search(r"\[[\s\S]*\]", text)
            if not json_match:
                return

            extracted = json.loads(json_match.group(0))
            for item in extracted:
                content = item.get("content", "").strip()
                if not content or len(content) > 50:
                    continue
                repos = _get_repositories()
                repos.save_memory(
                    user_id, content,
                    item.get("category", "fact"), 3,
                )
        except Exception:
            pass


class HistoryService:
    """问答历史管理"""

    @staticmethod
    def record(user_id: str, conversation_id: str, question: str, answer: str) -> dict:
        repos = _get_repositories()
        data = repos.save_memory(user_id, answer, source="conversation_extraction", source_conversation_id=conversation_id)
        return {
            "id": data["id"],
            "user_id": user_id,
            "conversation_id": conversation_id,
            "question": question,
            "answer": answer,
            "timestamp": data.get("created_at", ""),
        }

    @staticmethod
    def get_history(user_id: str, conversation_id: str = None, limit: int = 50) -> list[dict]:
        repos = _get_repositories()
        data = repos.search_memories(user_id, "", category=None, limit=limit)
        items = data.get("items", [])
        # 按 source_conversation_id 过滤
        if conversation_id:
            items = [m for m in items if m.get("source_conversation_id") == conversation_id]
        return items[:limit]
