# Agent 双版本项目

使用 **TypeScript + LangChain** 和 **Python + LangGraph** 实现同一套 Agent API。TS 版通过 `createAgent` 做声明式编排，Python 版通过 `StateGraph` 显式控制节点与边；两版独立维护工具、Prompt、配置和运行状态。当前实现覆盖轻量直答与完整 ReAct 工具链、用户隔离的会话/画像/长期记忆/知识库、图片生成、可恢复 Turn、流式 SSE、限流和分层超时。

## 核心对比

| 维度 | TS: LangChain | Python: LangGraph |
| --- | --- | --- |
| 编程模型 | 声明式配置：`createAgent({ model, tools, middleware })` | 显式图编排：`StateGraph().add_node().add_conditional_edges().compile()` |
| 控制流 | 隐式（框架内部处理循环） | 显式（自己定义每个节点和边） |
| 条件路由 | middleware 层面 | `add_conditional_edges()` 一等公民 |
| 状态管理 | 隐式消息列表 | 显式 TypedDict State |
| 持久化 | `MEMORY_ENABLED=true` 使用 Cloudflare Service；关闭时使用进程内仓储 | `MEMORY_ENABLED=true` 使用 Cloudflare Service；关闭时使用进程内仓储 |
| 请求可靠性 | `client_message_id` + Turn 状态机，原子写入用户/助手消息 | 与 TS 版保持相同 Turn 与幂等契约 |
| 性能治理 | Agent/Prompt 缓存、模型并发队列、后台任务池 | 编译图缓存、模型并发队列、后台任务池 |
| 人机协同 | 需自行实现 | 框架支持 `interrupt_before`，当前生产图未启用 |
| 多 Agent | 当前未实现，需自行编排 | 当前未实现，可用显式图继续扩展 |

## Cloudflare 持久化服务

`cloudflare-service/` 是独立部署在 Cloudflare Workers 上的长期记忆网关，负责：

- 用户画像（Profile）CRUD
- 会话与消息管理（Conversation + Message）
- 单轮执行管理（Turn）：幂等键、并发互斥、状态转换与异常恢复
- 长期记忆存储与语义搜索（Memory + Vectorize）
- 知识库文档管理（Document + RAG）
- 审计日志、工具指标和 LangGraph checkpoint
- 统一 Bearer Secret 认证

ts-langchain 和 py-langgraph 均通过 HTTP 调用此服务，不直接持有数据库凭证。

Cloudflare Service 是可选能力。`MEMORY_ENABLED=false` 时，两版都不会访问 Gateway、D1 或 Vectorize；会话、Turn、画像、记忆和知识文档保存在当前进程内，知识检索使用有界 Top-K 字符倒排索引，服务重启后本地数据会清空。`MEMORY_ENABLED=true` 时才需要配置 `CLOUDFLARE_MEMORY_BASE_URL` 和 `CLOUDFLARE_MEMORY_SECRET`。

持久化模式下，同一会话同一时刻只允许一个活动 Turn。`client_message_id` 在会话内唯一：重试已完成请求会复用结果，处理中或已失败的重复请求返回稳定的 `409`。Turn 开始与用户消息、Turn 完成与助手消息分别通过 D1 batch 原子提交；会话维护 `next_sequence_no` 和 `message_count`，避免每次写入扫描消息表。Cloudflare Cron 每 5 分钟回收陈旧 Turn，并通过带租约的索引任务消费避免多个 Worker 重复处理同一向量任务。

普通解释、翻译、写作、计划、比较和代码请求会走不携带工具 schema 的轻量模型路径；实时信息、计算、文件、知识库、记忆、推荐及未知意图保守保留完整工具链。高频固定问答可直接本地返回。模型输出默认限制为 4096 tokens；历史上下文单独按 16000 tokens 裁剪，并从完整用户轮次边界开始保留，降低无效上下文和推理成本。

## 项目结构

```text
agent/
├── cloudflare-service/       # Cloudflare Workers — 长期记忆网关（独立部署）
│   ├── src/
│   │   ├── config/                # Worker 配置
│   │   ├── index.ts               # Hono 入口，注册路由 + 中间件
│   │   ├── middleware/
│   │   │   ├── auth.ts            # Bearer Secret 鉴权
│   │   │   ├── error.ts           # 统一错误处理（Hono 4 兼容）
│   │   │   └── security.ts        # 请求日志 + 内容脱敏
│   │   ├── routes/
│   │   │   ├── health.ts          # 健康检查
│   │   │   ├── profile.ts         # PUT/GET /users/{id}/profile
│   │   │   ├── conversation.ts    # 会话 CRUD
│   │   │   ├── message.ts         # 消息批量写入/查询/清空
│   │   │   ├── turn.ts            # Turn 幂等、状态转换与恢复
│   │   │   ├── memory.ts          # 记忆 CRUD + 语义搜索
│   │   │   ├── document.ts        # 文档上传/列表/搜索/重新索引
│   │   │   ├── checkpoint.ts      # LangGraph checkpoint
│   │   │   ├── audit-log.ts       # 审计日志
│   │   │   ├── tool-metrics.ts    # 工具指标
│   │   │   └── openapi.ts         # GET /openapi.json
│   │   ├── repositories/          # D1 数据访问层（含 Turn 原子命令）
│   │   ├── services/              # Embedding 与带租约的异步索引任务
│   │   └── schemas/               # Zod 4 数据模型
│   ├── migrations/                # D1 迁移 SQL
│   ├── wrangler.jsonc             # Worker 配置（bindings: D1, Vectorize, AI）
│   └── package.json
│
├── ts-langchain/              # TS 版：纯 LangChain 声明式配置
│   ├── src/
│   │   ├── agents/
│   │   │   ├── chat-agent.ts       # 对话 Agent（ChatOpenAI 封装）
│   │   │   ├── tool-agent.ts       # 工具调用 Agent
│   │   │   ├── react-policy.ts     # ReAct 策略中间件
│   │   │   ├── deadline.ts         # Agent 执行超时控制
│   │   │   ├── response-handler.ts # 响应格式化处理
│   │   │   └── index.ts            # Agent 导出
│   │   ├── services/
│   │   │   └── index.ts            # 业务编排、Turn、缓存与后台任务
│   │   ├── rag/
│   │   │   ├── loader.ts           # 文档加载（TXT, MD）
│   │   │   ├── splitter.ts         # 文本切分（递归字符切分）
│   │   │   ├── embedder.ts         # 向量化（OpenAI Embedding）
│   │   │   ├── vector-store.ts     # Qdrant 向量存储
│   │   │   ├── retriever.ts        # 检索器
│   │   │   └── rag-agent.ts        # RAG Agent
│   │   ├── tools/
│   │   │   ├── registry.ts         # 工具注册中心
│   │   │   ├── contracts.ts        # ToolDescriptor / ToolCategory 定义
│   │   │   ├── index.ts            # 工具统一导出
│   │   │   ├── runtime/
│   │   │   │   ├── index.ts        # 运行时导出
│   │   │   │   ├── executor.ts     # ToolExecutor 安全执行器
│   │   │   │   └── data-redaction.ts # 数据脱敏
│   │   │   ├── weather.ts          # 天气查询
│   │   │   ├── web-search.ts       # 联网搜索
│   │   │   ├── web-read.ts         # 网页读取
│   │   │   ├── web-extract.ts      # 网页正文提取
│   │   │   ├── file-search.ts      # 文件内容检索
│   │   │   ├── calculator.ts       # 安全计算
│   │   │   ├── time.ts             # 当前时间与时区换算
│   │   │   ├── knowledge.ts        # 知识库检索
│   │   │   ├── memory-session.ts   # 会话记忆检索
│   │   │   ├── memory-user.ts      # 用户长期记忆（读写）
│   │   │   └── observability.ts    # 可观测性（审计日志）
│   │   ├── clients/
│   │   │   ├── memory_gateway.ts   # Cloudflare Service HTTP 客户端
│   │   │   └── schemas.ts          # 客户端数据模型
│   │   ├── repositories/           # 仓储层（Cloudflare + InMemory）
│   │   ├── api/
│   │   │   ├── routes/
│   │   │   │   ├── v1/             # External API（前端 UI 使用）
│   │   │   │   │   └── index.ts
│   │   │   │   ├── chat.ts
│   │   │   │   ├── stream.ts
│   │   │   │   ├── tools.ts
│   │   │   │   └── images.ts       # 图片生成
│   │   │   ├── middleware/
│   │   │   │   ├── auth.ts         # Bearer 鉴权
│   │   │   │   └── error.ts        # 统一错误处理
│   │   │   ├── sse.ts              # SSE 编码
│   │   │   ├── health.ts           # 存活与就绪状态
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
├── py-langgraph/              # Python 版：LangGraph 显式图编排
│   ├── src/
│   │   ├── agents/
│   │   │   ├── graph_agents.py    # StateGraph Agent 图构建
│   │   │   ├── react_policy.py   # ReAct 策略和状态限制
│   │   │   ├── deadline.py        # Agent 执行超时控制
│   │   │   └── response_handler.py # 响应格式化处理
│   │   ├── services/
│   │   │   └── __init__.py        # 业务编排、Turn、缓存与后台任务
│   │   ├── rag/
│   │   │   ├── loader.py          # 文档加载（TXT, MD）
│   │   │   ├── splitter.py        # 文本切分（递归字符切分）
│   │   │   ├── embedder.py        # 向量化（OpenAI Embedding）
│   │   │   ├── vector_store.py    # Qdrant 向量存储
│   │   │   ├── retriever.py       # 检索器
│   │   │   └── rag_agent.py       # RAG Agent（LangGraph 图）
│   │   ├── tools/
│   │   │   ├── registry.py        # 工具注册中心（ToolRegistry + 权限裁剪）
│   │   │   ├── contracts.py       # ToolDescriptor / ToolCategory / ToolRisk 定义
│   │   │   ├── __init__.py        # 工具统一导出
│   │   │   ├── weather.py         # 天气查询
│   │   │   ├── search.py          # 联网搜索
│   │   │   ├── web_read.py        # 网页读取
│   │   │   ├── web_extract.py     # 网页正文提取
│   │   │   ├── file_search.py     # 文件内容检索
│   │   │   ├── calculator.py      # 安全计算
│   │   │   ├── time.py            # 当前时间与时区换算
│   │   │   ├── knowledge.py       # 知识库检索
│   │   │   ├── memory_session.py  # 会话记忆检索
│   │   │   ├── memory_user.py     # 用户长期记忆（读写）
│   │   │   ├── observability.py   # 可观测性（审计日志）
│   │   │   └── runtime/
│   │   │       ├── __init__.py    # 运行时导出
│   │   │       ├── executor.py    # ToolExecutor 安全执行器
│   │   │       └── data_redaction.py # 数据脱敏
│   │   ├── clients/
│   │   │   └── memory_gateway.py  # Cloudflare Service HTTP 客户端
│   │   ├── repositories/           # 仓储层（Cloudflare Service）
│   │   ├── profile/
│   │   │   ├── models.py          # UserProfile / Memory / QARecord 模型
│   │   │   └── service.py         # ProfileService（画像 + 记忆 + 问答历史）
│   │   ├── api/
│   │   │   ├── routes/
│   │   │   │   ├── v1/            # External API（前端 UI 使用）
│   │   │   │   │   └── __init__.py
│   │   │   │   ├── chat.py
│   │   │   │   ├── stream.py
│   │   │   │   ├── tools.py
│   │   │   │   └── images.py      # 图片生成
│   │   │   ├── auth.py            # Bearer 鉴权
│   │   │   ├── request_logging.py # 请求日志
│   │   │   ├── sse.py             # SSE 编码
│   │   │   ├── health.py          # 存活与就绪状态
│   │   │   └── main.py            # FastAPI 应用入口
│   │   ├── prompts/
│   │   │   └── system.py          # Prompt 模板
│   │   ├── memory/
│   │   │   └── d1_checkpointer.py # D1 checkpoint 适配
│   │   └── config/
│   │       └── settings.py        # 环境变量配置（Pydantic Settings）
│   ├── pyproject.toml
│   ├── requirements.txt
│   ├── Dockerfile
│   ├── .dockerignore
│   ├── .editorconfig
│   ├── .gitignore
│   └── .env.example
│
├── docker-compose.yml      # ts-agent、py-agent 两个 profile
├── .env.example            # Compose 环境变量示例
└── README.md
```

## 快速开始

### 一键部署命令

```bash
bash deploy-ecs.sh typescript
bash deploy-ecs.sh python
bash deploy-ecs.sh all
```

### Cloudflare Service（记忆网关）

```bash
cd cloudflare-service
npm install
npx wrangler d1 migrations apply agent-db --local    # 初始化本地 D1
npx wrangler dev                                     # 本地开发（wrangler.jsonc 默认 localhost:6100）
npx wrangler secret put SERVICE_SECRET               # 设置 Bearer Secret
npx wrangler vectorize create-metadata-index memory-embeddings --propertyName user_id --type string
npx wrangler vectorize create-metadata-index memory-embeddings --propertyName category --type string
npx wrangler vectorize create-metadata-index memory-embeddings --propertyName active --type boolean
npx wrangler vectorize create-metadata-index memory-embeddings --propertyName entity_type --type string
npx wrangler vectorize create-metadata-index memory-embeddings --propertyName document_id --type string
npx wrangler deploy                                  # 部署到线上
```

Vectorize 元数据索引是 RAG 和用户隔离检索的前置条件；重复部署时先用 `npx wrangler vectorize list-metadata-index memory-embeddings` 检查，首次创建后需要等待 Cloudflare 完成异步索引构建。

### TypeScript 版本

```bash
cd ts-langchain
npm install
cp .env.example .env
# 编辑 .env；至少配置模型凭证和 AGENT_API_SECRET，图片与 Cloudflare Memory 按启用情况配置
npm run dev
```

服务：`http://localhost:6001`

### Python 版本

```bash
cd py-langgraph
pip install -r requirements.txt
cp .env.example .env
# 编辑 .env；至少配置模型凭证和 AGENT_API_SECRET，图片与 Cloudflare Memory 按启用情况配置
uvicorn src.api.main:app --reload
```

服务：`http://localhost:6002`

## API 接口

两个版本提供一致的接口：

除健康检查外，所有接口都要求 `Authorization: Bearer <AGENT_API_SECRET>`。涉及用户数据的接口还必须由可信服务端代理传入 `X-Agent-User-Id`；请求体或查询参数中的 `user_id` 只能与该身份一致，不能用于切换用户。

```
GET  /api/v1/health                    健康检查
GET  /api/v1/health/live               进程存活探针
GET  /api/v1/health/ready              模型与 Memory 配置就绪探针
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

图片生成独立使用 Cloudflare Workers AI 配置：`IMAGE_API_KEY`、`IMAGE_BASE_URL` 和
`IMAGE_MODEL=@cf/black-forest-labs/flux-2-klein-9b`。该模型使用 Workers AI 的免费每日配额，
成功时返回 `result.image` Base64 字符串；接口将其转换为 `image_data_url`，前端可直接作为图片
`src` 使用。

## Cloudflare Service 内部 API

ts-langchain 和 py-langgraph 通过以下内部 API 与 Cloudflare Service 通信（Bearer Secret 认证）：

这些内部接口仅在 `MEMORY_ENABLED=true` 时由 Agent 服务调用；关闭记忆网关时无需启动 `cloudflare-service/`。

```
PUT   /internal/v1/users/{user_id}/profile          创建/更新画像
GET   /internal/v1/users/{user_id}/profile          获取画像

POST  /internal/v1/conversations                    创建会话
GET   /internal/v1/users/{user_id}/conversations    列出会话
GET   /internal/v1/conversations/{id}               会话详情
DELETE /internal/v1/conversations/{id}              删除会话

POST  /internal/v1/conversations/{id}/messages:batch 批量写入消息
GET   /internal/v1/conversations/{id}/messages       查询消息
DELETE /internal/v1/conversations/{id}/messages       清空消息

POST  /internal/v1/conversations/{id}/turns:begin   原子创建/复用 Turn 并写入用户消息
POST  /internal/v1/turns/{turn_id}/complete         原子写入助手消息并完成 Turn
POST  /internal/v1/conversations/{id}/turns         创建/复用 Turn（兼容接口）
GET   /internal/v1/turns/{turn_id}?user_id=...      查询 Turn
PATCH /internal/v1/turns/{turn_id}                  更新 Turn 状态

PUT   /internal/v1/users/{user_id}/memories/{id}    保存记忆
GET   /internal/v1/users/{user_id}/memories         列出记忆
PATCH /internal/v1/users/{user_id}/memories/{id}    更新记忆
DELETE /internal/v1/users/{user_id}/memories/{id}   删除记忆
DELETE /internal/v1/users/{user_id}/memories        清空用户记忆
POST  /internal/v1/users/{user_id}/memories:search  语义搜索记忆

POST  /internal/v1/documents                        上传文档
GET   /internal/v1/documents                        列出文档
GET   /internal/v1/documents/{id}                   文档详情
DELETE /internal/v1/documents/{id}                  删除文档
POST  /internal/v1/documents/{id}/reindex           重新索引
POST  /internal/v1/documents:search                 语义搜索文档

POST  /internal/v1/checkpoints/{thread_id}          保存 LangGraph checkpoint
GET   /internal/v1/checkpoints/{thread_id}          读取最新 checkpoint
DELETE /internal/v1/checkpoints/{thread_id}         删除 checkpoint

POST  /internal/v1/audit-logs                       批量写入工具审计日志
GET   /internal/v1/audit-logs                       查询审计日志
DELETE /internal/v1/audit-logs                      清理审计日志

POST  /internal/v1/tool-metrics                     批量写入工具指标
GET   /internal/v1/tool-metrics                     查询指标明细
GET   /internal/v1/tool-metrics/snapshot            查询指标快照

GET   /internal/v1/openapi.json                     OpenAPI 规范
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
- **Agent 框架**：LangChain (`createAgent` 声明式配置)
- **工具定义**：Zod
- **API 框架**：Fastify
- **持久化**：进程内仓储或 Cloudflare Service (D1 + Vectorize)
- **测试**：Vitest

### Python 版

- **运行时**：Python 3.11+
- **Agent 框架**：LangGraph (`StateGraph` + `ToolNode`)
- **工具定义**：Pydantic
- **Checkpoint**：`MemorySaver` 或 Cloudflare D1 checkpointer
- **API 框架**：FastAPI
- **持久化**：进程内仓储或 Cloudflare Service (D1 + Vectorize)
- **测试**：pytest + pytest-asyncio
- **追踪**：LangSmith

### Cloudflare Service

- **运行时**：Cloudflare Workers
- **框架**：Hono 4
- **Schema**：Zod 4
- **数据库**：D1 (SQLite)
- **向量索引**：Vectorize
- **Embedding**：Workers AI (`@cf/baai/bge-m3`)
- **部署**：`wrangler deploy`
