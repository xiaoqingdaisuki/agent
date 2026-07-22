# TypeScript / Python双版本Agent项目

使用 **TypeScript + LangChain** 和 **Python + LangGraph** 实现同一个 Agent 需求，作为框架对比学习项目。

## 核心对比

| 维度 | TS: LangChain | Python: LangGraph |
| --- | --- | --- |
| 编程模型 | 声明式配置：`createOpenAIToolsAgent({ llm, tools, prompt })` | 显式图编排：`StateGraph().add_node().add_conditional_edges().compile()` |
| 控制流 | 隐式（框架内部处理循环） | 显式（自己定义每个节点和边） |
| 条件路由 | middleware 层面 | `add_conditional_edges()` 一等公民 |
| 状态管理 | 隐式消息列表 | 显式 TypedDict State |
| 持久化 | 无内置 | `checkpointer` 内置（对话可暂停/恢复） |
| 人机协同 | 需自行实现 | `interrupt_before` 原生支持 |
| 多 Agent | 需自行编排 | supervisor + `Command` 路由 |

## 项目结构

```text
agent/
├── ts-langchain/           # TS 版：纯 LangChain 声明式配置
│   ├── src/
│   │   ├── agents/
│   │   │   ├── chat-agent.ts       # 纯对话 Agent
│   │   │   ├── tool-agent.ts       # 工具调用 Agent
│   │   │   └── rag-agent.ts        # RAG Agent（检索器包装成 tool）
│   │   ├── rag/
│   │   │   ├── loader.ts           # 文档加载（TXT, MD）
│   │   │   ├── splitter.ts         # 文本切分（递归字符切分）
│   │   │   ├── embedder.ts         # 向量化（OpenAI Embedding）
│   │   │   ├── vector-store.ts     # Qdrant 向量存储
│   │   │   ├── retriever.ts        # 检索器
│   │   │   └── rag-agent.ts        # RAG Agent
│   │   ├── services/
│   │   │   └── index.ts            # Service Layer（业务编排）
│   │   ├── adapters/
│   │   │   ├── types.ts            # NormalizedMessage 统一消息格式
│   │   │   ├── qq.ts               # QQ 适配器（OneBot v11 HTTP）
│   │   │   ├── bot.ts              # Bot Service（指令 + Agent）
│   │   │   └── commands/
│   │   │       ├── registry.ts     # 指令注册中心
│   │   │       ├── help.ts         # /help
│   │   │       ├── status.ts       # /status
│   │   │       └── clear.ts        # /clear
│   │   ├── api/
│   │   │   ├── routes/
│   │   │   │   ├── v1/             # External API（前端 UI 使用）
│   │   │   │   │   └── index.ts
│   │   │   │   ├── internal/       # Internal API（QQ Bot 使用）
│   │   │   │   │   └── index.ts
│   │   │   │   ├── chat.ts
│   │   │   │   ├── stream.ts
│   │   │   │   └── tools.ts
│   │   │   ├── middleware/
│   │   │   │   └── error.ts        # 统一错误处理
│   │   │   └── index.ts            # Fastify 应用入口
│   │   ├── prompts/
│   │   │   └── system.ts           # Prompt 模板
│   │   ├── memory/
│   │   │   └── conversation.ts     # 会话记忆（内存 Map）
│   │   └── config/
│   │       └── index.ts            # 环境变量配置（Zod 校验）
│   ├── package.json
│   ├── tsconfig.json
│   └── .env.example
│
├── py-langgraph/           # Python 版：LangGraph 显式图编排
│   ├── src/
│   │   ├── agents/
│   │   │   ├── base.py            # 通用图构建基类
│   │   │   ├── chat_agent.py      # 对话 Agent（StateGraph: node=model）
│   │   │   ├── tool_agent.py      # 工具调用 Agent（StateGraph + ToolNode + 条件边）
│   │   │   └── rag_agent.py       # RAG Agent（StateGraph: retrieve → grade → generate）
│   │   ├── rag/
│   │   │   ├── loader.py          # 文档加载（TXT, MD）
│   │   │   ├── splitter.py        # 文本切分（递归字符切分）
│   │   │   ├── embedder.py        # 向量化（OpenAI Embedding）
│   │   │   ├── vector_store.py    # Qdrant 向量存储
│   │   │   ├── retriever.py       # 检索器
│   │   │   └── rag_agent.py       # RAG Agent
│   │   ├── services/
│   │   │   └── __init__.py        # Service Layer（业务编排）
│   │   ├── adapters/
│   │   │   ├── types.py           # NormalizedMessage 统一消息格式
│   │   │   ├── qq.py              # QQ 适配器（OneBot v11 HTTP）
│   │   │   ├── bot.py             # Bot Service（指令 + Agent）
│   │   │   ├── registry.py        # 指令注册中心
│   │   │   └── commands/
│   │   │       ├── help.py        # /help
│   │   │       ├── status.py      # /status
│   │   │       └── clear.py       # /clear
│   │   ├── api/
│   │   │   ├── routes/
│   │   │   │   ├── v1/            # External API（前端 UI 使用）
│   │   │   │   │   └── __init__.py
│   │   │   │   ├── internal/      # Internal API（QQ Bot 使用）
│   │   │   │   │   └── __init__.py
│   │   │   │   ├── chat.py
│   │   │   │   ├── stream.py
│   │   │   │   └── tools.py
│   │   │   └── main.py            # FastAPI 应用入口
│   │   ├── prompts/
│   │   │   └── system.py          # Prompt 模板
│   │   ├── memory/
│   │   │   └── checkpoint.py      # Checkpoint 存储（PostgresSaver）
│   │   └── config/
│   │       └── settings.py        # 环境变量配置（Pydantic Settings）
│   ├── pyproject.toml
│   ├── requirements.txt
│   └── .env.example
│
├── docker-compose.yml      # 共享基础设施（Postgres + Qdrant）
└── README.md
```

## 快速开始

### 基础设施

```bash
docker-compose up -d
```

### TypeScript 版本

```bash
cd ts-langchain
npm install
cp .env.example .env
# 编辑 .env 填入 OPENAI_API_KEY
npm run dev
```

服务：`http://localhost:6001`

### Python 版本

```bash
cd py-langgraph
pip install -r requirements.txt
cp .env.example .env
# 编辑 .env 填入 OPENAI_API_KEY
uvicorn src.api.main:app --reload
```

服务：`http://localhost:6002`

## API 接口

两个版本提供一致的接口：

```
GET  /api/v1/health                    健康检查
GET  /api/v1/capabilities              可用能力列表

POST /api/v1/conversations             创建会话
GET  /api/v1/conversations             列出会话
GET  /api/v1/conversations/:id         获取会话详情
DELETE /api/v1/conversations/:id       删除会话
POST /api/v1/conversations/:id/messages 发送消息
GET  /api/v1/conversations/:id/messages 获取历史
DELETE /api/v1/conversations/:id/messages 清空消息

POST /api/v1/knowledge/documents       上传文档（multipart/form-data）
GET  /api/v1/knowledge/documents       文档列表
GET  /api/v1/knowledge/documents/:id   文档详情
DELETE /api/v1/knowledge/documents/:id 删除文档
POST /api/v1/knowledge/documents/:id/reindex 重新索引
POST /api/v1/knowledge/search          知识检索
```

两个版本 Internal API（QQ Bot 使用）一致：

```
POST /api/internal/agent/chat           直接对话
POST /api/internal/agent/chat/stream    流式对话
```

## 开发工作流

```
1. 先在 ts-langchain/ 用声明式配置快速实现验证
2. 再在 py-langgraph/ 用显式图对照实现
3. 两个版本 API 接口保持一致，便于对比
```

## 技术栈

### TypeScript 版

- **运行时**：Node.js 20+
- **Agent 框架**：LangChain (`createOpenAIToolsAgent` + `AgentExecutor`)
- **工具定义**：Zod
- **API 框架**：Fastify
- **测试**：Vitest

### Python 版

- **运行时**：Python 3.11+
- **Agent 框架**：LangGraph (`StateGraph` + `ToolNode`)
- **工具定义**：Pydantic
- **Checkpoint**：PostgresSaver / SqliteSaver
- **API 框架**：FastAPI
- **追踪**：LangSmith
