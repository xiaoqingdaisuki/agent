# ts-langchain-agent

TypeScript + LangChain（`createAgent` 声明式配置）实现的 Agent 服务，对外契约与 `py-langgraph/` 保持一致。明确的普通生成任务走无工具轻量路径；实时信息、计算、文件、知识库、记忆、推荐和未知意图保留完整工具链。

与 `py-langgraph/` 形成框架对比：

| 维度 | TS: LangChain | Python: LangGraph |
| --- | --- | --- |
| 编程模型 | 声明式配置 | 显式图编排 |
| Agent 创建 | `createAgent({ model, tools, middleware })` | `StateGraph().add_node().compile()` |
| 控制流 | 框架内部隐式处理 | 你自己显式定义每一步 |

## 目录结构

```
src/
├── agents/
│   ├── chat-agent.ts       # 纯对话 Agent
│   ├── tool-agent.ts       # 工具调用 Agent
│   ├── react-policy.ts     # ReAct 策略中间件
│   ├── deadline.ts         # Agent 执行超时控制
│   ├── response-handler.ts # 响应格式化
│   └── index.ts            # Agent 导出
├── rag/
│   ├── loader.ts           # 文档加载（TXT, MD）
│   ├── splitter.ts         # 文本切分（递归字符切分）
│   ├── embedder.ts         # 向量化（OpenAI Embedding）
│   ├── vector-store.ts     # Qdrant 向量存储
│   ├── retriever.ts        # 检索器
│   └── rag-agent.ts        # RAG Agent
├── clients/
│   ├── memory_gateway.ts   # Cloudflare Service HTTP 客户端
│   └── schemas.ts          # 客户端数据模型
├── commands/
│   └── index.ts            # 命令入口
├── config/
│   └── index.ts            # 环境变量配置（Zod）
├── memory/
│   └── conversation.ts     # 会话记忆
├── profile/
│   ├── index.ts            # 用户画像模型
│   └── service.ts          # Profile、Memory、History 服务
├── repositories/
│   ├── index.ts            # 仓储实现
│   └── types.ts            # 仓储类型
├── services/
│   └── index.ts            # Service Layer（业务编排、本地知识检索、流式兼容）
├── api/
│   ├── routes/
│   │   ├── v1/             # External API（前端 UI 使用）
│   │   │   └── index.ts
│   │   ├── chat.ts
│   │   ├── stream.ts
│   │   ├── tools.ts
│   │   └── images.ts
│   ├── middleware/
│   │   ├── auth.ts         # Bearer 鉴权
│   │   └── error.ts        # 统一错误处理
│   ├── sse.ts              # SSE 编码
│   └── index.ts            # Fastify 应用入口
├── prompts/
│   └── system.ts           # Prompt 模板
└── tools/
    ├── registry.ts         # 工具注册中心
    ├── contracts.ts        # 工具契约
    ├── file-search.ts      # 文件内容检索
    ├── time.ts             # 当前时间与时区换算
    └── runtime/            # 工具安全执行和数据脱敏
```

## 环境要求

- Node.js >= 20.x
- npm >= 10.x
- OpenAI API Key（或兼容 OpenAI 格式的 LLM 提供商）

## 本地运行

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

```bash
cp .env.example .env
```

编辑 `.env`：

```env
# LLM 配置（二选一）
OPENAI_API_KEY=sk-your-api-key
OPENAI_MODEL=gpt-4o-mini
# ANTHROPIC_API_KEY=sk-ant-your-api-key
# ANTHROPIC_MODEL=claude-3-5-haiku-20241022

# 可选：自定义 API 地址（如使用代理或本地模型，如 Ollama）
OPENAI_BASE_URL=https://api.openai.com/v1

# 模型上下文、输出、并发和请求预算
# Context Window 总上下文 1000000；Input 与 Output 共同占用，不单独限制 Input
LLM_MAX_OUTPUT_TOKENS=128000
LLM_MAX_CONCURRENCY=2
AGENT_DEADLINE_MS=120000
AGENT_DEADLINE_WITH_TOOLS_MS=300000

# 服务端口
PORT=6001
AGENT_API_SECRET=replace-with-a-long-random-secret
CORS_ORIGIN=http://localhost:3000

# 默认关闭 Cloudflare Memory，使用进程内会话、画像、记忆和知识库
MEMORY_ENABLED=false
# MEMORY_ENABLED=true 时再填写以下两项
CLOUDFLARE_MEMORY_BASE_URL=https://your-worker.workers.dev
CLOUDFLARE_MEMORY_SECRET=your-secret

# Qdrant 向量数据库（RAG 功能需要）
QDRANT_URL=http://localhost:6333

# 实时搜索（统一使用 Tavily）
TAVILY_API_KEY=your-tavily-key
```

### 3. 启动服务

```bash
# 开发模式（tsx 热重载，无需编译）
npm run dev

# 或先编译再运行
npm run build
npm start
```

服务启动在 `http://localhost:6001`

### 4. 验证

```bash
curl http://localhost:6001/api/v1/health
```

## 部署

### 前置要求

- Docker >= 20.x
- Docker Compose >= 2.x

### 步骤

**1. 克隆仓库**

```bash
git clone <repo-url>
cd agent
```

**2. 配置环境变量**

```bash
cp ts-langchain/.env.example ts-langchain/.env
```

编辑 `ts-langchain/.env`，填入实际配置：

```env
OPENAI_API_KEY=sk-your-api-key
OPENAI_MODEL=gpt-4o-mini
PORT=6001
QDRANT_URL=http://qdrant:6333
```

注意：Docker 环境中 `QDRANT_URL` 应使用 Docker Compose 服务名 `qdrant` 而非 `localhost`。

**3. 构建并启动**

在项目根目录 `agent/` 运行：

```bash
docker-compose up --build ts-agent
```

**4. 后台运行**

```bash
docker-compose up -d ts-agent
```

**5. 查看日志**

```bash
docker-compose logs -f ts-agent
```

**6. 验证**

```bash
curl http://localhost:6001/api/v1/health
```

## API 接口

### External API（前端 UI 使用）

除 `/health` 和 `/api/v1/health` 外，请求必须携带 `Authorization: Bearer <AGENT_API_SECRET>`。涉及用户数据时还必须由可信服务端设置 `X-Agent-User-Id`；请求中的 `user_id` 只能与该身份一致。

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

GET  /api/v1/profile                   用户画像
PATCH /api/v1/profile                  更新画像
GET  /api/v1/memory                    记忆列表
POST /api/v1/memory                    添加记忆
DELETE /api/v1/memory                  删除记忆
GET  /api/v1/history                   问答历史
```

### Internal API（QQ Bot 使用）

当前版本不再暴露独立的 `/api/internal/agent/*` 路由。可信服务端使用兼容路由 `POST /chat`、`POST /stream`，并携带 Bearer 密钥和 `X-Agent-User-Id`；`GET /tools` 返回当前可用工具，`POST /images/generations` 提供图片生成。

## 环境变量

| 变量 | 说明 | 默认值 | 必填 |
| --- | --- | --- | --- |
| `OPENAI_API_KEY` | OpenAI API 密钥 | - | 是 |
| `OPENAI_MODEL` | 使用的模型 | `gpt-4o-mini` | 否 |
| `OPENAI_BASE_URL` | API 地址 | `https://api.openai.com/v1` | 否 |
| `LLM_MAX_OUTPUT_TOKENS` | 单次模型输出上限 | `128000` | 否 |
| `LLM_MAX_CONCURRENCY` | 进程内模型并发上限 | `2` | 否 |
| `AGENT_DEADLINE_MS` | 普通 Agent 总时限（毫秒） | `120000` | 否 |
| `AGENT_DEADLINE_WITH_TOOLS_MS` | 工具 Agent 总时限（毫秒） | `300000` | 否 |
| `ANTHROPIC_API_KEY` | Anthropic API 密钥 | - | 否 |
| `ANTHROPIC_MODEL` | Anthropic 模型 | `claude-3-5-haiku-20241022` | 否 |
| `PORT` | 服务端口 | `6001` | 否 |
| `AGENT_API_SECRET` | 外部 API Bearer 密钥 | 空 | 生产环境是 |
| `CORS_ORIGIN` | 允许的浏览器来源，逗号分隔 | 空 | 否 |
| `MEMORY_ENABLED` | 是否启用 Cloudflare Memory Gateway | `true` | 否 |
| `CLOUDFLARE_MEMORY_BASE_URL` | Memory Gateway 地址 | `http://localhost:8787` | 网关开启时 |
| `CLOUDFLARE_MEMORY_SECRET` | Memory Gateway Bearer 密钥 | 空 | 网关开启时 |
| `IMAGE_API_KEY` | Cloudflare Workers AI 图片密钥 | - | 图片功能是 |
| `IMAGE_BASE_URL` | Workers AI API 根地址 | Cloudflare API | 否 |
| `IMAGE_MODEL` | 图片生成模型 | `@cf/black-forest-labs/flux-2-klein-9b` | 否 |
| `QDRANT_URL` | Qdrant 地址 | `http://localhost:6333` | 否 |
| `TAVILY_API_KEY` | Tavily API 密钥 | - | 是（搜索功能） |
| `TAVILY_SEARCH_DEPTH` | 搜索深度：`basic` 或 `advanced` | `basic` | 否 |
| `SEARCH_TIMEOUT_MS` | 单个搜索源超时 | `4500` | 否 |
| `SEARCH_MAX_RESULTS` | 最终合并结果数 | `8` | 否 |
| `SEARCH_CACHE_TTL_SECONDS` | 实时结果短缓存时间 | `30` | 否 |
| `SEARCH_STALE_TTL_SECONDS` | 全部实时源失败时可用的旧缓存窗口 | `600` | 否 |

搜索底层只调用 Tavily。服务会对临时网络错误和限流进行一次重试，连续失败时短暂熔断，并在实时调用失败时返回标记清楚的旧缓存；不会回退到其他搜索网站或把模型训练数据伪装成实时结果。

`MEMORY_ENABLED=false` 时不会调用 Gateway、D1 或 Vectorize；会话、画像、记忆和文档保存在进程内，知识检索使用有界 Top-K 字符倒排索引，重启后数据清空。设置为 `true` 后才使用 Cloudflare Service 持久化。

## 故障排查

### 端口被占用

```bash
# Linux/Mac
lsof -i :6001
kill -9 <PID>

# Windows
netstat -ano | findstr :6001
taskkill /PID <PID> /F
```

### OpenAI API 错误

- 检查 `OPENAI_API_KEY` 是否正确
- 检查 API 余额是否充足
- 检查 `OPENAI_BASE_URL` 是否正确设置

### Qdrant 连接失败

- 当前公开知识库在 `MEMORY_ENABLED=false` 时不依赖 Qdrant
- 确保 Qdrant 服务已启动：`docker-compose up qdrant`
- Docker 环境中使用 `QDRANT_URL=http://qdrant:6333`
- 检查 Qdrant 端口映射：`docker-compose ps qdrant`

### Docker 构建失败

```bash
# 清理缓存重新构建
docker-compose build --no-cache ts-agent

# 查看详细日志
docker-compose build ts-agent 2>&1 | tail -50
```

## 项目脚本

```bash
npm run dev      # 开发模式（tsx 热重载）
npm run build    # TypeScript 编译到 dist/
npm start        # 启动编译后的服务
npm test         # 运行测试（vitest）
npm run test:run # 运行测试（不监听）
```
