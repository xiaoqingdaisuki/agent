/**
 * RAG Agent — TS 版（LangChain 声明式）
 *
 * 特点：
 * - 检索器包装成 tool，Agent 自主决定何时检索
 * - createOpenAIToolsAgent 配置驱动，框架内部处理推理循环
 * - 对比 Python 版的显式图：retrieve → grade → generate
 */

import { createOpenAIToolsAgent } from "langchain/agents";
import { AgentExecutor } from "langchain/agents";
import { ChatOpenAI } from "@langchain/openai";
import { ChatPromptTemplate, MessagesPlaceholder } from "@langchain/core/prompts";
import { Retriever } from "./retriever.js";
import { TextSplitter } from "./splitter.js";
import { DocumentLoader } from "./loader.js";
import { DynamicStructuredTool } from "langchain/tools";
import { Embedder } from "./embedder.js";
import { VectorStore } from "./vector-store.js";

export interface RAGOptions {
  qdrantUrl: string;
  collectionName: string;
  model?: string;
}

/**
 * 创建检索器工具
 * 将 RAG 检索包装成 LangChain Tool，Agent 可以自主调用
 */
function createRetrieverTool(retriever: Retriever) {
  return new DynamicStructuredTool({
    name: "search_knowledge_base",
    description: "Search the company knowledge base for relevant information. Use this when you need to find specific information from documents.",
    schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query",
        },
      },
      required: ["query"],
    } as any,
    func: async (input: { query: string }) => {
      const results = await retriever.retrieve(input.query);
      if (results.length === 0) {
        return "No relevant information found in the knowledge base.";
      }

      return results
        .map(
          (r, i) =>
            `[Document ${i + 1}] (score: ${r.score.toFixed(3)})\n${r.content}\nSource: ${r.metadata.filename}`
        )
        .join("\n\n");
    },
  });
}

export class RAGAgent {
  private retriever: Retriever;
  private splitter: TextSplitter;
  private embedder: Embedder;
  private vectorStore: VectorStore;
  private agent: Promise<AgentExecutor>;

  constructor(options: RAGOptions) {
    this.retriever = new Retriever({
      qdrantUrl: options.qdrantUrl,
      collectionName: options.collectionName,
    });
    this.splitter = new TextSplitter();
    this.embedder = new Embedder();
    this.vectorStore = new VectorStore({
      url: options.qdrantUrl,
      collectionName: options.collectionName,
    });
    this.agent = this.createAgent(options);
  }

  /**
   * 创建 RAG Agent — 声明式配置
   */
  private async createAgent(options: RAGOptions): Promise<AgentExecutor> {
    const model = new ChatOpenAI({
      modelName: options.model || process.env.OPENAI_MODEL || "gpt-4o-mini",
      configuration: {
        baseURL: process.env.OPENAI_BASE_URL,
        apiKey: process.env.OPENAI_API_KEY,
      },
    });

    const retrieverTool = createRetrieverTool(this.retriever);

    const prompt = ChatPromptTemplate.fromMessages([
      [
        "system",
        `You are a helpful AI assistant with access to a company knowledge base.

When answering questions:
1. First, search the knowledge base using the search_knowledge_base tool
2. If relevant information is found, use it to answer the question
3. Always cite the source document when using information from the knowledge base
4. If the knowledge base doesn't contain relevant information, say so honestly

Be concise and accurate in your responses.`,
      ],
      new MessagesPlaceholder("chat_history"),
      ["human", "{input}"],
      new MessagesPlaceholder("agent_scratchpad"),
    ]);

    // LangChain 声明式：prompt + createOpenAIToolsAgent + AgentExecutor
    const agent = await createOpenAIToolsAgent({
      llm: model as any,
      tools: [retrieverTool] as any,
      prompt,
    });

    return new AgentExecutor({
      agent: agent as any,
      tools: [retrieverTool] as any,
      verbose: false,
    });
  }

  /**
   * 索引文档
   */
  async indexDocument(
    content: string,
    filename: string,
    documentId?: string,
  ): Promise<{ chunks: number }> {
    const doc = await DocumentLoader.loadFromBuffer(Buffer.from(content), filename);
    const chunks = this.splitter.split(doc);

    const embeddings = await this.embedder.embedBatch(chunks.map((chunk) => chunk.text));
    await this.vectorStore.addDocuments(
      chunks.map((chunk) => ({
        content: chunk.text,
        metadata: { ...chunk.metadata, document_id: documentId ?? doc.id },
      })),
      embeddings,
    );

    return { chunks: chunks.length };
  }

  async deleteDocument(documentId: string): Promise<void> {
    await this.vectorStore.deleteDocuments(documentId);
  }

  /**
   * 对话
   */
  async chat(message: string, history: any[] = []) {
    const agent = await this.agent;
    const result = await agent.invoke(
      { input: message, chat_history: history },
      { configurable: { thread_id: "rag-session" } }
    );
    return result;
  }
}
