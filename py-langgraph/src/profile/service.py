"""
Profile Service — 用户画像 + 长期记忆 + 问答历史

核心能力：
1. get_or_create_profile: 懒加载用户画像
2. get_relevant_memories: 召回相关记忆（后续可接向量检索）
3. add_memory: 存储新记忆
4. record_qa: 记录问答
5. build_context_prompt: 将记忆注入 System Prompt
"""

import json
import re
import threading
from datetime import datetime

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI

from src.profile.models import Memory, ProfileStore, QARecord, UserProfile
from src.config.settings import settings

store = ProfileStore()


class ProfileService:
    """用户画像管理"""

    @staticmethod
    def get_or_create(user_id: str, name: str = "") -> UserProfile:
        profile = store.get_profile(user_id)
        if not profile:
            profile = UserProfile(id=user_id, name=name)
            store.create_profile(profile)
        else:
            store.update_profile(user_id)  # 更新 last_active_at
        return profile

    @staticmethod
    def get(user_id: str) -> UserProfile | None:
        return store.get_profile(user_id)

    @staticmethod
    def update(user_id: str, **updates) -> UserProfile | None:
        return store.update_profile(user_id, **updates)


class MemoryService:
    """长期记忆管理"""

    @staticmethod
    def add(user_id: str, content: str, category: str = "fact", importance: int = 3) -> Memory:
        """存储一条新记忆"""
        memory = Memory(
            id=f"mem_{datetime.now().strftime('%Y%m%d%H%M%S%f')}",
            user_id=user_id,
            content=content.strip(),
            category=category,
            importance=importance,
        )
        return store.add_memory(memory)

    @staticmethod
    def get_relevant(user_id: str, max_items: int = 10) -> list[Memory]:
        """获取用户的高优先级记忆"""
        memories = store.get_memories(user_id)
        # 按重要性排序，取 top N
        return memories[:max_items]

    @staticmethod
    def get_by_category(user_id: str, category: str) -> list[Memory]:
        return store.get_memories(user_id, category=category)

    @staticmethod
    def delete(user_id: str, memory_id: str) -> bool:
        return store.delete_memory(user_id, memory_id)

    @staticmethod
    def list_all(user_id: str) -> list[dict]:
        return [m.to_dict() for m in store.get_memories(user_id)]

    @staticmethod
    def build_memory_context(user_id: str) -> str:
        """将记忆组装成 prompt 片段，供注入 System Prompt"""
        memories = store.get_memories(user_id)[:10]
        if not memories:
            return ""

        lines = ["[我记住的关于你的事]"]
        for m in memories:
            lines.append(f"- {m.content}")
        lines.append("")
        return "\n".join(lines)

    @staticmethod
    def extract_memories_from_conversation(user_id: str, question: str, answer: str) -> list[Memory]:
        """从对话中提取值得记忆的事实（正则 + LLM 双层提取）"""
        # 第一层：正则规则立即提取
        regex_memories = MemoryService._extract_with_regex(user_id, question)
        for mem in regex_memories:
            store.add_memory(mem)

        # 第二层：LLM 异步提取（不阻塞主流程）
        thread = threading.Thread(
            target=MemoryService._extract_with_llm,
            args=(user_id, question, answer),
            daemon=True,
        )
        thread.start()

        return regex_memories

    @staticmethod
    def _extract_with_regex(user_id: str, question: str) -> list[Memory]:
        """正则规则提取 — 匹配明显的偏好/个人信息句式"""
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
                    new_memories.append(Memory(
                        id=f"mem_{datetime.now().strftime('%Y%m%d%H%M%S%f')}",
                        user_id=user_id,
                        content=f"用户喜欢/偏好: {content}",
                        category=category,
                        importance=4,
                    ))

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
                    new_memories.append(Memory(
                        id=f"mem_{datetime.now().strftime('%Y%m%d%H%M%S%f')}",
                        user_id=user_id,
                        content=f"用户信息: {content}",
                        category=category,
                        importance=5,
                    ))

        return new_memories

    @staticmethod
    def _extract_with_llm(user_id: str, question: str, answer: str) -> None:
        """LLM-based 记忆提取 — 处理正则覆盖不到的复杂表达"""
        if not settings.openai_api_key:
            return

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

        try:
            response = llm.invoke([
                SystemMessage(content="你只输出 JSON 数组，不输出其他内容。"),
                HumanMessage(content=prompt),
            ])
            text = response.content if isinstance(response.content, str) else ""

            import json
            json_match = re.search(r'\[[\s\S]*\]', text)
            if not json_match:
                return

            extracted = json.loads(json_match.group(0))
            for item in extracted:
                content = item.get("content", "").strip()
                if not content or len(content) > 50:
                    continue
                memory = Memory(
                    id=f"mem_{datetime.now().strftime('%Y%m%d%H%M%S%f')}",
                    user_id=user_id,
                    content=content,
                    category=item.get("category", "fact"),
                    importance=3,
                )
                store.add_memory(memory)
        except Exception:
            # LLM 提取失败静默降级
            pass


class HistoryService:
    """问答历史管理"""

    @staticmethod
    def record(user_id: str, conversation_id: str, question: str, answer: str) -> QARecord:
        record = QARecord(
            id=f"qa_{datetime.now().strftime('%Y%m%d%H%M%S%f')}",
            user_id=user_id,
            conversation_id=conversation_id,
            question=question,
            answer=answer,
        )
        return store.add_qa_record(record)

    @staticmethod
    def get_history(user_id: str, conversation_id: str = None, limit: int = 50) -> list[dict]:
        records = store.get_qa_history(user_id, conversation_id, limit)
        return [r.to_dict() for r in records]
