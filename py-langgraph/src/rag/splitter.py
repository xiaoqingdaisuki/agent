"""
RAG 文本切分器
按有界窗口切分，保持段落完整性
"""

from dataclasses import dataclass


@dataclass
class TextChunk:
    text: str
    index: int
    metadata: dict


class TextSplitter:
    """按段落优先的迭代字符切分器"""

    # 初始化文本切分器，设置块大小和重叠长度
    def __init__(
        self,
        chunk_size: int = 1000,
        chunk_overlap: int = 200,
    ):
        if type(chunk_size) is not int or chunk_size <= 0:
            raise ValueError("chunk_size 必须为正整数")
        if type(chunk_overlap) is not int or not 0 <= chunk_overlap < chunk_size:
            raise ValueError("chunk_overlap 必须为非负整数且小于 chunk_size")
        self.chunk_size = chunk_size
        self.chunk_overlap = chunk_overlap

    # 执行 split 对应的业务逻辑
    def split(self, content: str, filename: str, source: str) -> list[TextChunk]:
        """切分文档内容"""
        chunks = self._split_text(content)

        return [
            TextChunk(
                text=chunk,
                index=i,
                metadata={
                    "source": source,
                    "filename": filename,
                    "chunk_index": i,
                    "total_chunks": len(chunks),
                },
            )
            for i, chunk in enumerate(chunks)
        ]

    # 逐个有界窗口选择分隔点，确保重叠后仍向前推进且大文档不耗尽调用栈。
    def _split_text(self, text: str) -> list[str]:
        """迭代切分，避免递归堆栈与大段剩余文本的反复复制。"""
        chunks = []
        separators = ["\n\n", "\n", "。", ". ", " "]
        offset = 0
        while len(text) - offset > self.chunk_size:
            window = text[offset : offset + self.chunk_size]
            split_at = self.chunk_size
            for separator in separators:
                position = window.rfind(separator)
                end = position + len(separator)
                if position > self.chunk_size * 0.3 and end > self.chunk_overlap:
                    split_at = end
                    break
            chunks.append(window[:split_at].strip())
            offset += split_at - self.chunk_overlap
        chunks.append(text[offset:])
        return chunks
