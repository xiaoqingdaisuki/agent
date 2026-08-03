# TypeScript / Python双版本Agent项目

使用 **TypeScript + LangChain** 和 **Python + LangGraph** 实现同一个 Agent 需求，作为框架对比学习项目。

## 核心对比

| 维度 | TS: LangChain | Python: LangGraph |
| --- | --- | --- |
| 编程模型 | 声明式配置：`createOpenAIToolsAgent({ llm, tools, prompt })` | 显式图编排：`StateGraph().add_node().add_conditional_edges().compile()` |
| 控制流 | 隐式（框架内部处理循环） | 显式（自己定义每个节点和边） |
| 条件路由 | middleware 层面 | `add_conditional_edges()` 一等公民 |
| 状态管理 | 隐式消息列表 | 显式 TypedDict State |
| 持久化 | 无 checkpoint（会话记忆存内存 Map） | `checkpointer` 内置（PostgresSaver，对话可暂停/恢复） |
| 人机协同 | 需自行实现 | `interrupt_before` 原生支持（工具调用前可插入人工确认） |
| 多 Agent | 需自行编排 | supervisor + `Command` 路由 |

## 项目结构

```text
agent/
├── ts-langchain/           # TS 版：纯 LangChain 声明式配置
│   ├── src/
│   │   ├── agents/
│   │   │   ├── chat-agent.ts       # 对话 Agent（ChatOpenAI 封装）
│   │   │   └── tool-agent.ts       # 工具调用 Agent
│   │   ├── rag/
│   │   │   ├── loader.ts           # 文档加载（TXT, MD）
│   │   │   ├── splitter.ts         # 文本切分（递归字符切分）
│   │   │   ├── embedder.ts         # 向量化（OpenAI Embedding）
│   │   │   ├── vector-store.ts     # Qdrant 向量存储
│   │   │   ├── retriever.ts        # 检索器
│   │   │   └── rag-agent.ts        # RAG Agent
│   │   ├── services/
│   │   │   └── index.ts            # Service Layer（业务编排）
│   │   ├── tools/
│   │   │   ├── registry.ts         # 工具注册中心
│   │   │   ├── contracts.ts        # ToolDescriptor / ToolCategory 定义
│   │   │   ├── runtime/
│   │   │   │   ├── index.ts        # 运行时导出
│   │   │   │   └── executor.ts     # ToolExecutor 安全执行器
│   │   │   ├── weather.ts          # 天气查询
│   │   │   ├── web-search.ts       # 联网搜索
│   │   │   ├── web-read.ts         # 网页读取
│   │   │   ├── file-read.ts        # 文件读取
│   │   │   ├── calculator.ts       # 安全计算
│   │   │   ├── knowledge.ts        # 知识库检索
│   │   │   ├── memory-session.ts   # 会话记忆检索
│   │   │   ├── memory-user.ts      # 用户长期记忆（读写）
│   │   │   └── observability.ts    # 可观测性（审计日志）
│   │   ├── api/
│   │   │   ├── routes/
│   │   │   │   ├── v1/             # External API（前端 UI 使用）
│   │   │   │   │   └── index.ts
│   │   │   │   ├── chat.ts
│   │   │   │   ├── stream.ts
│   │   │   │   ├── tools.ts
│   │   │   │   └── images.ts       # 图片生成
│   │   │   ├── middleware/
│   │   │   │   └── error.ts        # 统一错误处理
│   │   │   └── index.ts            # Fastify 应用入口
│   │   ├── profile/
│   │   │   ├── index.ts            # UserProfile / Memory / QARecord 模型
│   │   │   └── service.ts          # ProfileService（画像 + 记忆 + 问答历史）
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
│   │   │   ├── base.py            # 通用图构建基类（AgentState, get_llm）
│   │   │   ├── chat_agent.py      # 对话 Agent（StateGraph: node=model）
│   │   │   ├── tool_agent.py      # 工具调用 Agent（StateGraph + ToolNode + 条件边）
│   │   │   └── rag_agent.py       # RAG Agent（StateGraph: retrieve → grade → generate）
│   │   ├── rag/
│   │   │   ├── loader.py          # 文档加载（TXT, MD）
│   │   │   ├── splitter.py        # 文本切分（递归字符切分）
│   │   │   ├── embedder.py        # 向量化（OpenAI Embedding）
│   │   │   ├── vector_store.py    # Qdrant 向量存储
│   │   │   ├── retriever.py       # 检索器
│   │   │   └── rag_agent.py       # RAG Agent（LangGraph 图）
│   │   ├── services/
│   │   │   └── __init__.py        # Service Layer（业务编排）
│   │   ├── tools/
│   │   │   ├── registry.py        # 工具注册中心（ToolRegistry + 权限裁剪）
│   │   │   ├── contracts.py       # ToolDescriptor / ToolCategory / ToolRisk 定义
│   │   │   ├── weather.py         # 天气查询
│   │   │   ├── search.py          # 联网搜索
│   │   │   ├── fetcher.py         # 网页读取
│   │   │   ├── file_reader.py     # 文件读取
│   │   │   ├── calculator.py      # 安全计算
│   │   │   ├── knowledge.py       # 知识库检索
│   │   │   ├── memory_session.py  # 会话记忆检索
│   │   │   ├── memory_user.py     # 用户长期记忆（读写）
│   │   │   ├── observability.py   # 可观测性（审计日志）
│   │   │   └── runtime/
│   │   │       ├── __init__.py    # 运行时导出
│   │   │       └── executor.py    # ToolExecutor 安全执行器
│   │   ├── profile/
│   │   │   ├── models.py          # UserProfile / Memory / QARecord / ProfileStore
│   │   │   └── service.py         # ProfileService（画像 + 记忆 + 问答历史）
│   │   ├── api/
│   │   │   ├── routes/
│   │   │   │   ├── v1/            # External API（前端 UI 使用）
│   │   │   │   │   └── __init__.py
│   │   │   │   ├── chat.py
│   │   │   │   ├── stream.py
│   │   │   │   ├── tools.py
│   │   │   │   └── images.py      # 图片生成
│   │   │   └── main.py            # FastAPI 应用入口
│   │   ├── prompts/
│   │   │   └── system.py          # Prompt 模板
│   │   ├── memory/
│   │   │   └── __init__.py        # 记忆模块（LangGraph Checkpoint 由图层管理）
│   │   └── config/
│   │       └── settings.py        # 环境变量配置（Pydantic Settings）
│   ├── pyproject.toml
│   ├── requirements.txt
│   └── .env.example
│
├── contracts/
│   └── tools/
│       ├── context.schema.json    # 工具上下文 Schema
│       ├── error.schema.json      # 工具错误 Schema
│       └── manifest.schema.json   # 工具清单 Schema
│
├── docker-compose.yml      # 共享基础设施（Postgres + Qdrant）
└── README.md
```

## 快速开始

### 一键部署命令

```bash
bash deploy-ecs.sh typescript
bash deploy-ecs.sh python
bash deploy-ecs.sh all
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
POST /api/v1/conversations/:id/messages/stream 流式发送消息（SSE）
GET  /api/v1/conversations/:id/messages 获取历史
DELETE /api/v1/conversations/:id/messages 清空消息

POST /api/v1/knowledge/documents       上传文档（multipart/form-data）
GET  /api/v1/knowledge/documents       文档列表
GET  /api/v1/knowledge/documents/:id   文档详情
DELETE /api/v1/knowledge/documents/:id 删除文档
POST /api/v1/knowledge/documents/:id/reindex 重新索引
POST /api/v1/knowledge/search          知识检索

GET  /api/v1/profile?user_id=xxx       用户画像
PATCH /api/v1/profile                  更新画像

GET  /api/v1/memory?user_id=xxx        记忆列表
POST /api/v1/memory                    添加记忆
DELETE /api/v1/memory                  删除记忆

GET  /api/v1/history?user_id=xxx       问答历史
```

旧路由（保留兼容）：

```
POST /chat                              直接对话
POST /stream                            流式对话
GET  /tools                             可用工具列表
POST /images/generations                图片生成
```

生产环境的超时应按从内到外递增配置：`AGENT_DEADLINE_MS=30000`、
`SERVER_REQUEST_TIMEOUT_MS=40000`（外部网关读超时也至少 40 秒）、Vibe
`AGENT_REQUEST_TIMEOUT_MS=45000`。流式路由需要关闭代理缓冲，以便会话元数据立即作为首个 SSE 事件发出。

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
- **Checkpoint**：LangGraph 内置（PostgresSaver / SqliteSaver）
- **API 框架**：FastAPI
- **测试**：pytest + pytest-asyncio
- **追踪**：LangSmith
