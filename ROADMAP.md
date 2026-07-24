# Agent 双版本项目 — 精简开发路线

> 适用项目：`ts-langchain/`、`py-langgraph/`
> 更新日期：2026-07-24

---

## 现状速览

| 模块 | 已有能力 | 主要问题 |
|---|---|---|
| 工具 | 4 个原型：`weather`, `web_search`, `fetch_url`, `calculator` | 无统一 Runtime，calculator 有安全隐患，搜索返回非结构化 |
| Agent | TS：`createAgent` 声明式；Python：`StateGraph` 显式图 | 可用，无权限控制 |
| 记忆 | 进程内 Map + 规则提取 | 重启丢失，无用户隔离 |
| RAG | 基础向量检索 | 无 ACL 过滤，未接入统一 Tool 链 |
| API | Fastify / FastAPI，`/chat`, `/stream`, `/api/v1/*` | 无认证，裸奔 |
| 安全/权限 | 无 | 全缺失 |

---

## 目标

- **读/写/记忆** 能力完整
- **Search 最强**：互联网搜索 + 知识库检索，结构化返回
- **安全 & 权限**：统一 Runtime 门禁，审计可追踪
- 前端是 **Web AI 助手**，不需要工作流编排、邮件发送、代码沙箱等复杂能力

---

## 两阶段开发

### Phase 0：安全底座（第 1-2 周）

**先做这个，再开发任何新功能。** 目标：让现有工具通过统一 Runtime 安全执行，无绕过路径。

#### 1. 统一 Tool Descriptor

定义语言无关的 JSON Schema，每个工具声明：

```json
{
  "name": "web.read",
  "version": "1.0.0",
  "risk_level": "R1",
  "side_effect": "read",
  "timeout_ms": 10000,
  "required_permissions": ["web.read"],
  "input_schema": {},
  "output_schema": {}
}
```

风险等级：R0（无副作用）→ R1（只读）→ R2（有副作用，可恢复）→ R3（高风险，需审批）

#### 2. 统一 Tool Runtime / Executor

所有工具通过 `ToolRuntime.invoke()` 执行，管线：

```
参数校验 → permission_check → policy_check → 执行 → 结果脱敏 → 审计记录
```

业务工具不得绕过 Runtime 直接执行。

#### 3. 修复现有工具

| 工具 | 修复项 |
|---|---|
| `calculator` | TS：替换 `Function()` 为安全表达式解析器；Python：替换 `eval()` 为 AST 解析 |
| `fetch_url` → `web.read` | 增加 SSRF 防护（协议白名单、私有 IP 拒绝）、响应大小限制、内容类型检查、重定向复检 |
| `web_search` | 返回结构化结果 `{title, url, snippet, provider, retrieved_at}`，增加去重、降级策略 |

#### 4. RBAC 基础

- 在 Runtime 层实现 `permission_check`：校验 `user_id / tenant / action`
- 参数严格校验（JSON Schema，拒绝额外字段）
- 结果脱敏（秘密 / PII 不进入模型上下文）
- 审计记录（谁、何时、调用了什么、参数摘要、结果摘要、耗时）

#### Phase 0 验收标准

- 现有 4 个工具全部接入 Runtime
- TS `npm run build` 零错误；Python `ruff check src/` 零错误
- 无绕过 Guard 的执行路径

---

### Phase 1：核心能力闭环（第 3-5 周）

**目标**：Search 最强、Read 完整、Memory 可用。

#### 1. SEARCH（最高优先级）

| 工具 | 说明 |
|---|---|
| `web.search` | 多来源互联网搜索，结构化返回（title/url/snippet/provider/rank），去重、缓存、配额、降级 |
| `knowledge.search` | RAG 向量检索接入统一 Tool 链，检索前 ACL 过滤，返回带文档引用（doc_id, page, score） |

#### 2. READ

| 工具 | 说明 |
|---|---|
| `web.read` | Phase 0 加固后的网页读取，增加 HTML/PDF 解析、正文清洗、内容安全标记 |
| `file.read` | 路径规范化、根目录约束、符号链接防逃逸、文件类型/大小白名单、编码检测、分段读取、敏感字段脱敏 |

#### 3. MEMORY

| 能力 | 说明 |
|---|---|
| 会话记忆 | 绑定会话与租户，上下文压缩，过期策略，不得跨会话泄露 |
| 用户记忆 `memory.user.search/save` | 升级现有 Profile/Memory：来源、置信度、更新时间；用户可查看/纠正/删除 |
| 记忆提取 | 规则提取 → LLM 语义提取（更精准） |

#### 4. 可观测性

- OpenTelemetry trace：关联 `trace_id / conversation_id / tool_call_id`
- 核心指标：调用量、成功率、拒绝率、P50/P95/P99 延迟、搜索无结果率、知识引用命中率
- 离线评测：工具选择准确率、参数生成正确性、引用正确性

#### Phase 1 验收标准

- Search 能力完整可用（互联网 + 知识库）
- Read / Memory 达到生产标准
- 有 trace 和基础指标

---

## 不做的事情

| 能力 | 理由 |
|---|---|
| `CONTROL` 全类（workflow、plan、human.approval） | 前端是 Web AI 助手，不需要复杂工作流编排 |
| `message.send` / `email.send` | 不需要 |
| `code.execute` 沙箱 | 非核心，后续按需加 |
| `database.query` / `database.mutate` | 无数据库需求 |
| `image.understand` / `media.understand` | 非核心，后续按需加 |
| Tool 开发者门户 / 灰度回滚 | 平台化能力，后续阶段 |

---

## 核心原则

1. **共享契约，不共享代码**：两个项目各自实现，工具名/语义/错误码保持一致
2. **先建 Runtime，再加新 Tool**：权限/审计/超时逻辑统一在 Runtime 层，不散落到每个函数
3. **读写分离、预览与执行分离**：高风险操作必须支持人工审批（Phase 1 不做写入，Phase 2 按需再加）
4. **每轮只暴露最小工具集**：不向模型暴露全量注册表
