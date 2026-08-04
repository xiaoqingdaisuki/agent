/**
 * RAG 文本切分器
 * 递归字符切分，保持段落完整性
 */

export interface TextChunk {
  text: string;
  index: number;
  metadata: {
    source: string;
    filename: string;
    chunkIndex: number;
    totalChunks: number;
  };
}

export interface SplitterOptions {
  chunkSize: number;      // 每块最大字符数，默认 1000
  chunkOverlap: number;   // 块间重叠字符数，默认 200
}

export class TextSplitter {
  private chunkSize: number;
  private chunkOverlap: number;

  // 初始化文本切分器，设置块大小和重叠长度
  constructor(options: SplitterOptions = { chunkSize: 1000, chunkOverlap: 200 }) {
    this.chunkSize = options.chunkSize;
    this.chunkOverlap = options.chunkOverlap;
  }

  /**
   * 切分文档内容
   */
  split(doc: { content: string; metadata: { source: string; filename: string } }): TextChunk[] {
    const chunks = this.recursiveSplit(doc.content);
    return chunks.map((text, index) => ({
      text,
      index,
      metadata: {
        source: doc.metadata.source,
        filename: doc.metadata.filename,
        chunkIndex: index,
        totalChunks: chunks.length,
      },
    }));
  }

  /**
   * 递归字符切分
   * 优先按段落（\n\n）切分，其次按句子（\n）切分，最后按字符切分
   */
  private recursiveSplit(text: string): string[] {
    // 如果文本足够短，直接返回
    if (text.length <= this.chunkSize) {
      return [text];
    }

    const chunks: string[] = [];
    const separators = ["\n\n", "\n", "。", ". ", " ", ""];

    // 找到最佳分割点
    let splitAt = -1;
    for (const sep of separators) {
      const pos = text.lastIndexOf(sep, this.chunkSize);
      if (pos > this.chunkSize * 0.3) {
        // 在 chunkSize 之前找到分割点
        splitAt = pos + sep.length;
        break;
      }
    }

    if (splitAt === -1) {
      // 硬切分
      splitAt = this.chunkSize;
    }

    const chunk = text.slice(0, splitAt).trim();
    const remaining = text.slice(splitAt - this.chunkOverlap);

    chunks.push(chunk);
    chunks.push(...this.recursiveSplit(remaining));

    return chunks;
  }
}
