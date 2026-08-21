/**
 * RAG Agent — TS 版（LangChain 声明式）
 *
 * 特点：
 * - 检索器包装成 tool，Agent 自主决定何时检索
 * - createOpenAIToolsAgent 配置驱动，框架内部处理推理循环
 * - 文档向量存储在 Cloudflare Service（Vectorize），通过 Memory Gateway 访问
 */

import { createOpenAIToolsAgent } from "@langchain/classic/agents";
import { AgentExecutor } from "@langchain/classic/agents";
import { ChatOpenAI } from "@langchain/openai";
import {
  ChatPromptTemplate,
  MessagesPlaceholder,
} from "@langchain/core/prompts";
import { Retriever } from "./retriever.js";
import { DynamicStructuredTool } from "@langchain/core/tools";

export interface RAGOptions {
  /** 用户 ID（用于文档搜索） */
  userId: string;
  /** Cloudflare Memory Gateway 地址 */
  baseUrl?: string;
  /** Gateway 认证密钥 */
  secret?: string;
  /** 模型名称 */
  model?: string;
}

/**
 * 创建检索器工具
 * 将 RAG 检索包装成 LangChain Tool，Agent 可以自主调用
 */
// 创建或注册 createRetrieverTool 所需的数据
function createRetrieverTool(retriever: Retriever) {
  return new DynamicStructuredTool({
    name: "search_knowledge_base",
    description:
      "Search the company knowledge base for relevant information. Use this when you need to find specific information from documents.",
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
            `[Document ${i + 1}] (score: ${r.score.toFixed(3)})\n${r.content}\nSource: ${r.metadata.filename || r.metadata.document_name || "unknown"}`,
        )
        .join("\n\n");
    },
  });
}

export class RAGAgent {
  private retriever: Retriever;
  private agent: Promise<AgentExecutor>;

  // 初始化当前对象
  constructor(options: RAGOptions) {
    this.retriever = new Retriever(
      {
        baseUrl: options.baseUrl,
        secret: options.secret,
      },
      options.userId,
    );
    this.agent = this.createAgent(options);
  }

  /**
   * 创建 RAG Agent — 声明式配置
   */
  // 创建或注册 createAgent 所需的数据
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
   * 对话
   */
  // 执行 chat 对应的业务逻辑
  async chat(message: string, history: any[] = []) {
    const agent = await this.agent;
    const result = await agent.invoke(
      { input: message, chat_history: history },
      { configurable: { thread_id: "rag-session" } },
    );
    return result;
  }
}
