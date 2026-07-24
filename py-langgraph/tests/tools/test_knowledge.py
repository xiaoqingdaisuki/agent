"""
Tests for knowledge.search Tool
"""

import pytest
from src.tools.knowledge import knowledge_search, _DESCRIPTOR, KnowledgeHit, hits_to_text


class TestKnowledgeSearchDescriptor:
    def test_descriptor_fields(self):
        assert _DESCRIPTOR.name == "knowledge.search"
        assert _DESCRIPTOR.version == "1.0.0"
        assert _DESCRIPTOR.category == "SEARCH"
        assert _DESCRIPTOR.risk_level == "R1"
        assert _DESCRIPTOR.side_effect == "read"
        assert "knowledge.search" in _DESCRIPTOR.required_permissions

    def test_descriptor_timeout(self):
        assert _DESCRIPTOR.timeout_ms == 12000

    def test_descriptor_tags(self):
        assert "rag" in _DESCRIPTOR.tags
        assert "vector" in _DESCRIPTOR.tags


class TestHitsToText:
    def test_empty_hits(self):
        text = hits_to_text([], "test query")
        assert "未找到" in text
        assert "test query" in text

    def test_single_hit(self):
        hits = [KnowledgeHit(
            doc_id="doc_1",
            doc_name="手册.pdf",
            content="这是相关内容",
            score=0.95,
            chunk_index=2,
        )]
        text = hits_to_text(hits, "test")
        assert "[1]" in text
        assert "手册.pdf" in text
        assert "0.95" in text

    def test_multiple_hits(self):
        hits = [
            KnowledgeHit(doc_id="d1", doc_name="A", content="content A", score=0.9, chunk_index=0),
            KnowledgeHit(doc_id="d2", doc_name="B", content="content B", score=0.8, chunk_index=1),
        ]
        text = hits_to_text(hits, "q")
        assert "[1]" in text
        assert "[2]" in text
        assert "A" in text
        assert "B" in text


class TestKnowledgeSearchTool:
    @pytest.mark.asyncio
    async def test_tool_returns_string(self):
        """知识库搜索在没有真实 Qdrant 时返回错误或空结果"""
        result = await knowledge_search.ainvoke({"query": "test", "top_k": 3})
        assert isinstance(result, str)
        assert len(result) > 0

    @pytest.mark.asyncio
    async def test_tool_handles_empty_query(self):
        result = await knowledge_search.ainvoke({"query": "", "top_k": 3})
        assert isinstance(result, str)
        # 空查询也应该返回某种结果
        assert len(result) > 0
