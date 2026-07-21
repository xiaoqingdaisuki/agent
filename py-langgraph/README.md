# py-langgraph-agent

Python + LangGraph（显式 StateGraph 图编排）实现的 Agent 服务。

与 `ts-langchain/` 形成框架对比：

| 维度 | TS: LangChain | Python: LangGraph |
| --- | --- | --- |
| 编程模型 | 声明式配置 | 显式图编排 |
| Agent 创建 | `createOpenAIToolsAgent({ llm, tools, prompt })` | `StateGraph().add_node().add_conditional_edges().compile()` |
| 控制流 | 框架内部隐式处理 | 你自己显式定义每一步 |
| 条件路由 | middleware 层面 | `add_conditional_edges()` 一等公民 |
| 持久化 | 无内置 | `checkpointer` 内置（对话可暂停/恢复） |
| 人机协同 | 需自行实现 | `interrupt_before` 原生支持 |

## 目录结构

```
src/
├── agents/
│   ├── base.py            # 通用图构建基类
│   ├── chat_agent.py      # 对话 Agent（StateGraph: node=model）
│   ├── tool_agent.py      # 工具调用 Agent（StateGraph + ToolNode + 条件边）
│   └── rag_agent.py       # RAG Agent（StateGraph: retrieve → grade → generate）
├── rag/
│   ├── loader.py          # 文档加载（TXT, MD）
│   ├── splitter.py        # 文本切分（递归字符切分）
│   ├── embedder.py        # 向量化（OpenAI Embedding）
│   ├── vector_store.py    # Qdrant 向量存储
│   ├── retriever.py       # 检索器
│   └── rag_agent.py       # RAG Agent
├── services/
│   └── __init__.py        # Service Layer（业务编排）
├── adapters/
│   ├── types.py           # NormalizedMessage 统一消息格式
│   ├── qq.py              # QQ 适配器（OneBot v11 HTTP）
│   ├── bot.py             # Bot Service（指令 + Agent）
│   ├── registry.py        # 指令注册中心
│   └── commands/
│       ├── help.py        # /help
│       ├── status.py      # /status
│       └── clear.py       # /clear
├── api/
│   ├── routes/
│   │   ├── v1/            # External API（前端 UI 使用）
│   │   │   └── __init__.py
│   │   ├── internal/      # Internal API（QQ Bot 使用）
│   │   │   └── __init__.py
│   │   ├── chat.py
│   │   ├── stream.py
│   │   └── tools.py
│   └── main.py            # FastAPI 应用入口
├── prompts/
│   └── system.py          # Prompt 模板
├── memory/
│   └── checkpoint.py      # Checkpoint 存储（PostgresSaver）
└── config/
    └── settings.py        # 环境变量配置（Pydantic Settings）
```

## 环境要求

- Python >= 3.11
- pip >= 24.x
- OpenAI API Key（或兼容 OpenAI 格式的 LLM 提供商）
- PostgreSQL（可选，用于 LangGraph checkpoint 持久化）
- Qdrant（可选，用于 RAG 向量存储）

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

# API 服务
HOST=0.0.0.0
PORT=3002

# 数据库（checkpoint 持久化，可选）
POSTGRES_URI=postgresql://agent:agent@localhost:5432/agent

# Qdrant 向量数据库（RAG 功能需要）
QDRANT_URL=http://localhost:6333
```

### 3. 启动服务

```bash
# 开发模式（uvicorn 热重载）
uvicorn src.api.main:app --reload

# 生产模式
uvicorn src.api.main:app --host 0.0.0.0 --port 3002
```

服务启动在 `http://localhost:3002`

### 4. 验证

```bash
curl http://localhost:3002/api/v1/health
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
PORT=3002
POSTGRES_URI=postgresql://agent:agent@postgres:5432/agent
QDRANT_URL=http://qdrant:6333
```

注意：Docker 环境中 `POSTGRES_URI` 和 `QDRANT_URL` 应使用 Docker Compose 服务名（`postgres`、`qdrant`）而非 `localhost`。

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
curl http://localhost:3002/api/v1/health
```

## API 接口

### External API（前端 UI 使用）

```
GET  /api/v1/health                    健康检查
GET  /api/v1/capabilities              可用能力列表

POST /api/v1/conversations             创建会话
GET  /api/v1/conversations             列出会话
GET  /api/v1/conversations/{conv_id}   获取会话详情
DELETE /api/v1/conversations/{conv_id} 删除会话
POST /api/v1/conversations/{conv_id}/messages 发送消息
GET  /api/v1/conversations/{conv_id}/messages 获取历史
DELETE /api/v1/conversations/{conv_id}/messages 清空消息

POST /api/v1/knowledge/documents       上传文档（multipart/form-data）
GET  /api/v1/knowledge/documents       文档列表
GET  /api/v1/knowledge/documents/{doc_id} 文档详情
DELETE /api/v1/knowledge/documents/{doc_id} 删除文档
POST /api/v1/knowledge/documents/{doc_id}/reindex 重新索引
POST /api/v1/knowledge/search          知识检索
```

### Internal API（QQ Bot 使用）

```
POST /api/internal/agent/chat           直接对话
POST /api/internal/agent/chat/stream    流式对话
```

## 环境变量

| 变量 | 说明 | 默认值 | 必填 |
| --- | --- | --- | --- |
| `OPENAI_API_KEY` | OpenAI API 密钥 | - | 是 |
| `OPENAI_MODEL` | 使用的模型 | `gpt-4o-mini` | 否 |
| `OPENAI_BASE_URL` | API 地址 | `https://api.openai.com/v1` | 否 |
| `ANTHROPIC_API_KEY` | Anthropic API 密钥 | - | 否 |
| `ANTHROPIC_MODEL` | Anthropic 模型 | `claude-3-5-haiku-20241022` | 否 |
| `HOST` | 服务监听地址 | `0.0.0.0` | 否 |
| `PORT` | 服务端口 | `3002` | 否 |
| `POSTGRES_URI` | PostgreSQL 连接字符串 | `postgresql://agent:agent@localhost:5432/agent` | 否 |
| `QDRANT_URL` | Qdrant 地址 | `http://localhost:6333` | 否 |

## 故障排查

### 端口被占用

```bash
# Linux/Mac
lsof -i :3002
kill -9 <PID>

# Windows
netstat -ano | findstr :3002
taskkill /PID <PID> /F
```

### OpenAI API 错误

- 检查 `OPENAI_API_KEY` 是否正确
- 检查 API 余额是否充足
- 检查 `OPENAI_BASE_URL` 是否正确设置

### Qdrant 连接失败

- 确保 Qdrant 服务已启动：`docker-compose up qdrant`
- Docker 环境中使用 `QDRANT_URL=http://qdrant:6333`

### PostgreSQL 连接失败

- 确保 PostgreSQL 已启动：`docker-compose up postgres`
- 检查 `POSTGRES_URI` 格式是否正确
- 确认数据库用户权限

## 项目脚本

```bash
# 使用 uvicorn 开发模式（热重载）
uvicorn src.api.main:app --reload

# 生产模式
uvicorn src.api.main:app --host 0.0.0.0 --port 3002

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
    llm = ChatOpenAI(model="gpt-4o-mini")

    def agent_node(state: AgentState):
        response = llm.invoke(state["messages"])
        return {"messages": [response]}

    builder = StateGraph(AgentState)
    builder.add_node("agent", agent_node)
    builder.add_edge(START, "agent")
    builder.add_edge("agent", END)

    return builder.compile()
```

## QQ 机器人部署

### 前置要求

- LLOneBot（QQ 协议层）
- 一个可用的 QQ 号（建议使用专用小号）

### 步骤

**1. 部署 LLOneBot**

参考 [LLOneBot 官方文档](https://llonebot.cn/) 部署协议层。

确保 LLOneBot 的 HTTP API 地址可访问，默认 `http://localhost:8080`。

**2. 配置环境变量**

在 `.env` 中添加：

```env
ONE_BOT_API_URL=http://localhost:8080
```

**3. 启动 Bot**

```python
# 在项目根目录运行
python -c "
from src.adapters.qq import QQAdapter
from src.adapters.bot import BotService
import asyncio

async def main():
    adapter = QQAdapter(base_url='http://localhost:8080')
    bot = BotService(adapter)
    await bot.start()

asyncio.run(main())
"
```

### 可用指令

| 指令 | 功能 |
|------|------|
| `/help` | 列出所有可用指令 |
| `/status` | 查看机器人运行状态 |
| `/clear` | 清除当前会话记忆 |
