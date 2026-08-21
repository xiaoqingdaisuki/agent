# Agent 双版本项目

## 项目定位

同一套 Agent 功能，两个独立项目：
- **ts-langchain/**：纯 LangChain（`createAgent` 声明式配置），作为快速验证原型
- **py-langgraph/**：LangGraph（`StateGraph` 显式图编排），作为生产增强版

两个项目**完全独立**，各自维护自己的上下文（工具、Prompt、配置），互不依赖。
目的是对比 LangChain 声明式 vs LangGraph 显式图控制的编程范式差异。

## 与 Vibe 项目的协作

- 本仓库的 Agent 项目是 Vibe 项目中 Agent 功能的 API 服务。
- 定位问题或修复 Bug 时，如有必要，可以阅读 Vibe 项目代码进行联合分析，并开展前后端联调。

## 开发规范

- TS 项目：TypeScript strict 模式，ESM
- Python 项目：Python 3.11+，ruff 格式化，pytest 测试
- 两个项目的 API 接口保持一致（/chat, /stream, /tools, /health）
- 性能永远是编码的第一优先考虑的。

### 注释规范

**所有源文件的函数/方法前必须添加中文注释，说明函数作用或逻辑。**

- 普通函数注释：单行注释，`<=1` 行，放在函数定义前一行
- TS 使用 `//`，Python 使用 `#`
- 大型文档注释块（文件头部的 `/** ... */` 或 `""" ... """`）和顶部多行注释不受此规则限制
- test 文件不在此规则范围内
- 新增任何函数也必须遵守此规则

### 编译验证规则

**任何代码修改完成后，必须本地编译/检查通过才能提交：**

- TS 项目：运行 `npm run build`（tsc），必须零错误
- Python 项目：运行 `ruff check src/`，必须零错误
- 如果编译报错，必须修改到编译通过为止，不能跳过

## 基础设施

`docker-compose.yml` 提供共享基础设施

## 目录结构

每个项目内部：
```
src/
  agents/     — Agent 实现
  tools/      — 工具定义
  rag/        — RAG 组件（后续阶段）
  memory/     — 记忆管理
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
