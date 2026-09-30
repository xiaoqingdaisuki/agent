/**
 * RAG 文本切分器
 * 按有界窗口切分，保持段落完整性
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
  chunkSize: number; // 每块最大字符数，默认 1000
  chunkOverlap: number; // 块间重叠字符数，默认 200
}

export class TextSplitter {
  private chunkSize: number;
  private chunkOverlap: number;

  // 初始化文本切分器，设置块大小和重叠长度
  constructor(
    options: SplitterOptions = { chunkSize: 1000, chunkOverlap: 200 },
  ) {
    if (!Number.isInteger(options.chunkSize) || options.chunkSize <= 0) {
      throw new RangeError("chunkSize 必须为正整数");
    }
    if (
      !Number.isInteger(options.chunkOverlap)
      || options.chunkOverlap < 0
      || options.chunkOverlap >= options.chunkSize
    ) {
      throw new RangeError("chunkOverlap 必须为非负整数且小于 chunkSize");
    }
    this.chunkSize = options.chunkSize;
    this.chunkOverlap = options.chunkOverlap;
  }

  /**
   * 切分文档内容
   */
  // 执行 split 对应的业务逻辑
  split(doc: {
    content: string;
    metadata: { source: string; filename: string };
  }): TextChunk[] {
    const chunks = this.splitText(doc.content);
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
   * 迭代字符切分
   * 优先按段落（\n\n）切分，其次按句子（\n）切分，最后按字符切分
   */
  // 逐个有界窗口选择分隔点，确保重叠后仍向前推进且大文档不耗尽调用栈。
  private splitText(text: string): string[] {
    const chunks: string[] = [];
    const separators = ["\n\n", "\n", "。", ". ", " "];
    let offset = 0;
    while (text.length - offset > this.chunkSize) {
      const window = text.slice(offset, offset + this.chunkSize);
      let splitAt = this.chunkSize;
      for (const separator of separators) {
        const position = window.lastIndexOf(separator);
        const end = position + separator.length;
        if (position > this.chunkSize * 0.3 && end > this.chunkOverlap) {
          splitAt = end;
          break;
        }
      }
      chunks.push(window.slice(0, splitAt).trim());
      offset += splitAt - this.chunkOverlap;
    }
    chunks.push(text.slice(offset));
    return chunks;
  }
}
