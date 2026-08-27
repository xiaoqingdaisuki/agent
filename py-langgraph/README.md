# py-langgraph-agent

Python + LangGraph（显式 `StateGraph` 图编排）实现的 Agent 服务，对外契约与 `ts-langchain/` 保持一致。明确的普通生成任务走无工具轻量图；实时信息、计算、文件、知识库、记忆、推荐和未知意图保留完整工具图。

与 `ts-langchain/` 形成框架对比：

| 维度 | TS: LangChain | Python: LangGraph |
| --- | --- | --- |
| 编程模型 | 声明式配置 | 显式图编排 |
| Agent 创建 | `createAgent({ model, tools, middleware })` | `StateGraph().add_node().add_conditional_edges().compile()` |
| 控制流 | 框架内部隐式处理 | 你自己显式定义每一步 |
| 条件路由 | middleware 层面 | `add_conditional_edges()` 一等公民 |
| 持久化 | 无内置 | `checkpointer` 内置（对话可暂停/恢复） |
| 人机协同 | 需自行实现 | `interrupt_before` 原生支持 |

## 目录结构

```
src/
├── agents/
│   ├── graph_agents.py    # StateGraph、对话 Agent、工具 Agent
│   ├── react_policy.py    # ReAct 策略和状态限制
│   ├── deadline.py        # Agent 执行超时控制
│   └── response_handler.py # 响应格式化处理
├── rag/
│   ├── loader.py          # 文档加载（TXT, MD）
│   ├── splitter.py        # 文本切分（递归字符切分）
│   ├── embedder.py        # 向量化（OpenAI Embedding）
│   ├── vector_store.py    # Qdrant 向量存储
│   ├── retriever.py       # 检索器
│   └── rag_agent.py       # RAG Agent
├── services/
│   └── __init__.py        # 业务编排、Turn、后台任务与流式回退
├── clients/
│   ├── memory_gateway.py  # Cloudflare Service HTTP 客户端
│   └── schemas.py         # 客户端数据模型
├── config/
│   └── settings.py        # 环境变量配置（Pydantic Settings）
├── memory/
│   └── d1_checkpointer.py # D1 checkpoint 适配
├── profile/
│   ├── models.py          # 用户画像模型
│   └── service.py         # Profile、Memory、History 服务
├── repositories/
│   └── __init__.py        # 仓储抽象
├── api/
│   ├── routes/
│   │   ├── v1/            # External API（前端 UI 使用）
│   │   │   └── __init__.py
│   │   ├── chat.py
│   │   ├── stream.py
│   │   ├── tools.py
│   │   └── images.py
│   ├── auth.py            # Bearer 鉴权
│   ├── request_logging.py # 请求日志
│   ├── sse.py             # SSE 编码
│   ├── health.py          # liveness/readiness 状态
│   └── main.py            # FastAPI 应用入口
├── prompts/
│   └── system.py          # Prompt 模板
└── tools/
    ├── registry.py        # 工具注册中心
    ├── contracts.py       # 工具契约
    ├── file_search.py     # 文件内容检索
    ├── time.py            # 当前时间与时区换算
    └── runtime/           # 工具安全执行和数据脱敏
```

## 环境要求

- Python >= 3.11
- pip >= 24.x
- OpenAI API Key（或兼容 OpenAI 格式的 LLM 提供商）
- Qdrant（可选，仅用于独立 RAG 向量存储模块）

## 本地运行

### 1. 安装依赖

```bash
pip install -r requirements.txt
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

# 可选：自定义 API 地址
OPENAI_BASE_URL=https://api.openai.com/v1

# 模型上下文、输入、输出、并发和请求预算
LLM_MAX_CONTEXT_TOKENS=128000
LLM_MAX_INPUT_TOKENS=48000
LLM_MAX_OUTPUT_TOKENS=16000
HISTORY_CONTEXT_TOKEN_BUDGET=48000
LLM_MAX_CONCURRENCY=2
LLM_QUEUE_MAX=100
LLM_QUEUE_TIMEOUT_MS=5000
LLM_TIMEOUT_MS=30000
LLM_MAX_RETRIES=1
AGENT_DEADLINE_MS=120000
AGENT_DEADLINE_WITH_TOOLS_MS=300000
SERVER_REQUEST_TIMEOUT_MS=310000
REACT_MAX_STEPS=8
REACT_MAX_TOOL_CALLS=6
REACT_MAX_SAME_TOOL_CALLS=3
REACT_MAX_TOTAL_TIME_MS=30000
BACKGROUND_TASK_CONCURRENCY=4
BACKGROUND_TASK_QUEUE_MAX=200

# API 服务
HOST=0.0.0.0
PORT=6002
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
# 开发模式（uvicorn 热重载）
uvicorn src.api.main:app --reload

# 生产模式
uvicorn src.api.main:app --host 0.0.0.0 --port 6002
```

服务启动在 `http://localhost:6002`

### 4. 验证

```bash
curl http://localhost:6002/api/v1/health
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
cp py-langgraph/.env.example py-langgraph/.env
```

编辑 `py-langgraph/.env`，填入实际配置：

```env
OPENAI_API_KEY=sk-your-api-key
OPENAI_MODEL=gpt-4o-mini
HOST=0.0.0.0
PORT=6002
QDRANT_URL=http://qdrant:6333
```

注意：当前 `docker-compose.yml` 只编排 Agent 服务；如额外启用独立 RAG 向量模块，需要自行提供 Qdrant，并将 `QDRANT_URL` 设置为容器可访问地址。

**3. 构建并启动**

在项目根目录 `agent/` 运行：

```bash
docker-compose up --build py-agent
```

**4. 后台运行**

```bash
docker-compose up -d py-agent
```

**5. 查看日志**

```bash
docker-compose logs -f py-agent
```

**6. 验证**

```bash
curl http://localhost:6002/api/v1/health
```

## API 接口

### External API（前端 UI 使用）

除 `/health` 和 `/api/v1/health` 外，请求必须携带 `Authorization: Bearer <AGENT_API_SECRET>`。涉及用户数据时还必须由可信服务端设置 `X-Agent-User-Id`；请求中的 `user_id` 只能与该身份一致。

```
GET  /api/v1/health                    健康检查
GET  /api/v1/health/live               进程存活探针
GET  /api/v1/health/ready              依赖配置就绪探针
GET  /api/v1/capabilities              可用能力列表

POST /api/v1/conversations             创建会话
GET  /api/v1/conversations             列出会话
GET  /api/v1/conversations/{conv_id}   获取会话详情
DELETE /api/v1/conversations/{conv_id} 删除会话
POST /api/v1/conversations/{conv_id}/messages 发送消息
POST /api/v1/conversations/{conv_id}/messages/stream 流式发送消息（SSE）
GET  /api/v1/conversations/{conv_id}/messages 获取历史
DELETE /api/v1/conversations/{conv_id}/messages 清空消息

POST /api/v1/knowledge/documents       上传文档（multipart/form-data）
GET  /api/v1/knowledge/documents       文档列表
GET  /api/v1/knowledge/documents/{doc_id} 文档详情
DELETE /api/v1/knowledge/documents/{doc_id} 删除文档
POST /api/v1/knowledge/documents/{doc_id}/reindex 重新索引
POST /api/v1/knowledge/search          知识检索

GET  /api/v1/profile                   用户画像
PATCH /api/v1/profile                  更新画像
GET  /api/v1/memory                    记忆列表
POST /api/v1/memory                    添加记忆
DELETE /api/v1/memory                  删除记忆
GET  /api/v1/history                   问答历史
```

消息请求可选携带 `client_message_id`（1～128 字符）。客户端重试时应复用同一值；普通响应与 SSE `meta` 都返回 `turn_id`。已完成请求会直接复用结果，处理中、失败/取消或会话已有其他活动 Turn 时返回 `409`。SSE 每 15 秒发送注释心跳，业务事件使用 `turn_id:sequence` 单调 ID，同时保留历史客户端使用的 `[DONE]`。

### Internal API（QQ Bot 使用）

当前版本不再暴露独立的 `/api/internal/agent/*` 路由。可信服务端使用兼容路由 `POST /chat`、`POST /stream`，并携带 Bearer 密钥和 `X-Agent-User-Id`；`GET /tools` 返回当前可用工具，`POST /images/generations` 提供图片生成。

## 环境变量

| 变量 | 说明 | 默认值 | 必填 |
| --- | --- | --- | --- |
| `OPENAI_API_KEY` | OpenAI API 密钥 | - | 是 |
| `OPENAI_MODEL` | 使用的模型 | `gpt-4o-mini` | 否 |
| `OPENAI_BASE_URL` | API 地址 | `https://api.openai.com/v1` | 否 |
| `LLM_MAX_CONTEXT_TOKENS` | Agent 最大上下文窗口（允许 1024～128000） | `128000` | 否 |
| `LLM_MAX_INPUT_TOKENS` | Agent 最大输入 token 数（允许 1024～48000） | `48000` | 否 |
| `LLM_MAX_OUTPUT_TOKENS` | 单次模型输出上限（允许 256～16000） | `16000` | 否 |
| `HISTORY_CONTEXT_TOKEN_BUDGET` | 注入模型的历史上下文预算（不超过输入上限） | `48000` | 否 |
| `LLM_MAX_CONCURRENCY` | 进程内模型并发上限 | `2` | 否 |
| `LLM_QUEUE_MAX` | 模型等待队列上限 | `100` | 否 |
| `LLM_QUEUE_TIMEOUT_MS` | 模型排队超时（毫秒） | `5000` | 否 |
| `LLM_TIMEOUT_MS` | 单次模型调用超时（毫秒） | `30000` | 否 |
| `LLM_MAX_RETRIES` | 模型临时错误重试次数 | `1` | 否 |
| `AGENT_DEADLINE_MS` | 普通 Agent 总时限（毫秒） | `120000` | 否 |
| `AGENT_DEADLINE_WITH_TOOLS_MS` | 工具 Agent 总时限（毫秒） | `300000` | 否 |
| `SERVER_REQUEST_TIMEOUT_MS` | HTTP 请求总时限（毫秒） | `310000` | 否 |
| `REACT_MAX_STEPS` | ReAct 最大模型步骤数 | `8` | 否 |
| `REACT_MAX_TOOL_CALLS` | ReAct 最大工具调用数 | `6` | 否 |
| `REACT_MAX_SAME_TOOL_CALLS` | 相同工具参数最大调用次数 | `3` | 否 |
| `REACT_MAX_TOTAL_TIME_MS` | ReAct 内部工具循环预算（毫秒） | `30000` | 否 |
| `BACKGROUND_TASK_CONCURRENCY` | 后台任务并发上限 | `4` | 否 |
| `BACKGROUND_TASK_QUEUE_MAX` | 后台任务队列上限 | `200` | 否 |
| `ANTHROPIC_API_KEY` | Anthropic API 密钥 | - | 否 |
| `ANTHROPIC_MODEL` | Anthropic 模型 | `claude-3-5-haiku-20241022` | 否 |
| `HOST` | 服务监听地址 | `0.0.0.0` | 否 |
| `PORT` | 服务端口 | `6002` | 否 |
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

`MEMORY_ENABLED=false` 时不会调用 Gateway、D1 或 Vectorize；会话、画像、记忆和文档保存在进程内，知识检索使用有界 Top-K 字符倒排索引，LangGraph checkpoint 使用 `MemorySaver`，重启后数据清空。设置为 `true` 后才使用 Cloudflare Service 和 D1 checkpointer。

`MEMORY_ENABLED=true` 时，Turn、用户消息和助手消息通过 Gateway 原子提交，checkpoint 写入会清除旧分片并保持每个 thread 的版本顺序。旧版 Gateway 缺少 Turn API 时会切换进程内兼容存储并记录警告；线上应完成最新 D1 迁移，避免服务重启后丢失幂等状态。

## 故障排查

### 端口被占用

```bash
# Linux/Mac
lsof -i :6002
kill -9 <PID>

# Windows
netstat -ano | findstr :6002
taskkill /PID <PID> /F
```

### OpenAI API 错误

- 检查 `OPENAI_API_KEY` 是否正确
- 检查 API 余额是否充足
- 检查 `OPENAI_BASE_URL` 是否正确设置

## 项目脚本

```bash
# 使用 uvicorn 开发模式（热重载）
uvicorn src.api.main:app --reload

# 生产模式
uvicorn src.api.main:app --host 0.0.0.0 --port 6002

# 运行测试
pytest

# 代码格式化
ruff check src/
ruff format src/
```

## 核心代码示例

### 创建 Agent（显式图编排）

```python
from langgraph.graph import StateGraph, START, END
from langchain_openai import ChatOpenAI
from typing import TypedDict, Annotated
import operator

class AgentState(TypedDict):
    messages: Annotated[list, operator.add]

def build_agent():
    # 构建最小显式状态图，真实项目实现见 src/agents/graph_agents.py。
    llm = ChatOpenAI(model="gpt-4o-mini")

    # 调用模型并把 AI 消息追加回图状态。
    def agent_node(state: AgentState):
        response = llm.invoke(state["messages"])
        return {"messages": [response]}

    builder = StateGraph(AgentState)
    builder.add_node("agent", agent_node)
    builder.add_edge(START, "agent")
    builder.add_edge("agent", END)

    return builder.compile()
```
