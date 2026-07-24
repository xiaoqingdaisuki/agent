"""
RAG 文本切分器
递归字符切分，保持段落完整性
"""

from dataclasses import dataclass


@dataclass
class TextChunk:
    text: str
    index: int
    metadata: dict


class TextSplitter:
    """递归字符切分器"""

    def __init__(
        self,
        chunk_size: int = 1000,
        chunk_overlap: int = 200,
    ):
        self.chunk_size = chunk_size
        self.chunk_overlap = chunk_overlap

    def split(self, content: str, filename: str, source: str) -> list[TextChunk]:
        """切分文档内容"""
        chunks = self._recursive_split(content)

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

    def _recursive_split(self, text: str) -> list[str]:
        """递归切分"""
        if len(text) <= self.chunk_size:
            return [text]

        chunks = []
        separators = ["\n\n", "\n", "。", ". ", " "]

        # 找最佳分割点
        split_at = -1
        for sep in separators:
            pos = text.rfind(sep, 0, self.chunk_size)
            if pos > self.chunk_size * 0.3:
                split_at = pos + len(sep)
                break

        if split_at == -1:
            split_at = self.chunk_size

        chunk = text[:split_at].strip()
        remaining = text[split_at - self.chunk_overlap :]

        chunks.append(chunk)
        chunks.extend(self._recursive_split(remaining))

        return chunks
