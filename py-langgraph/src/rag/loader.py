"""
RAG 文档加载器
支持 TXT, Markdown 文件
"""

import os
from dataclasses import dataclass, field


@dataclass
class Document:
    content: str
    metadata: dict = field(default_factory=dict)

    @classmethod
    def from_file(cls, file_path: str) -> "Document":
        """从文件加载文档"""
        filename = os.path.basename(file_path)
        ext = os.path.splitext(filename)[1].lower()

        with open(file_path, "r", encoding="utf-8") as f:
            content = f.read()

        stats = os.stat(file_path)

        return cls(
            content=content,
            metadata={
                "source": file_path,
                "filename": filename,
                "file_type": ext,
                "size": stats.st_size,
                "uploaded_at": __import__("datetime").datetime.now().isoformat(),
            },
        )

    @classmethod
    def from_bytes(cls, content: bytes, filename: str) -> "Document":
        """从字节流加载（用于上传场景）"""
        ext = os.path.splitext(filename)[1].lower()

        return cls(
            content=content.decode("utf-8"),
            metadata={
                "source": f"upload://{filename}",
                "filename": filename,
                "file_type": ext,
                "size": len(content),
                "uploaded_at": __import__("datetime").datetime.now().isoformat(),
            },
        )
