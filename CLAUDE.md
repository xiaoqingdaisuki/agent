# Agent 双版本项目

## 项目定位

同一套 Agent 功能，两个独立项目：
- **ts-langchain/**：纯 LangChain（`createAgent` 声明式配置），作为快速验证原型
- **py-langgraph/**：LangGraph（`StateGraph` 显式图编排），作为生产增强版

两个项目**完全独立**，各自维护自己的上下文（工具、Prompt、配置），互不依赖。
目的是对比 LangChain 声明式 vs LangGraph 显式图控制的编程范式差异。

## 开发规范

- TS 项目：TypeScript strict 模式，ESM
- Python 项目：Python 3.11+，ruff 格式化，pytest 测试
- 两个项目的 API 接口保持一致（/chat, /stream, /tools, /health）

### 编译验证规则

**任何代码修改完成后，必须本地编译/检查通过才能提交：**

- TS 项目：运行 `npm run build`（tsc），必须零错误
- Python 项目：运行 `ruff check src/`，必须零错误
- 如果编译报错，必须修改到编译通过为止，不能跳过

## 基础设施

`docker-compose.yml` 提供共享基础设施：
- Postgres 16 — Python 版 LangGraph checkpoint 存储
- Qdrant — RAG 向量数据库

## 目录结构

每个项目内部：
```
src/
  agents/     — Agent 实现
  tools/      — 工具定义
  rag/        — RAG 组件（后续阶段）
  memory/     — 记忆管理
  profile/    — 用户画像 + 长期记忆 + 问答历史
  prompts/    — Prompt 模板
  api/        — API 服务层
  config/     — 配置管理
tests/        — 测试
```

## 工作流

新需求流程：
1. 先在 ts-langchain/ 用 `createAgent` 快速实现验证
2. 再在 py-langgraph/ 用 `StateGraph` 对照实现
3. 两版本 API 接口保持一致，便于对比
