# 记忆系统与上下文管理实现 Spec

## Why

依据 [context-memory-design.md](../../../finclaw/docs/context-memory-design.md)，当前各指令链路（主对话、方案生成、洞察、提取）各自取数、全量序列化（`JSON.stringify(ctx, null, 2)`）、逐轮拼 `[会话上下文]` 消息前缀，导致上下文超发、缓存不友好、跨会话业务失忆、长会话无压缩兜底。本变更按设计文档三阶段落地统一「记忆 + 上下文」体系。

## What Changes

### 阶段一 · 收口与瘦身
- 新建 `pi-gateway/src/workflow/context-builder.ts`：指令 scope 判定、字段白名单投影（toLeafContext）、紧凑 JSON 序列化 + 预算控制 + token 估算日志。
- `fetchContext` 支持 scope 参数（`plan` / `customer`），按 scope 只取所需记忆；**停止拉取 strategies**（方案引擎不依赖，`WorkflowContext.strategies` 改为可选）。
- `llm-leaf.ts` 的 `buildPrompt` 改走投影 + 紧凑序列化（去掉 `null, 2` 缩进）。
- 合并 backend HTTP 基建：`workflow/backend-client.ts` 复用 `tools/backend-http.ts` 的 loadConfig/backendGet，删除其私有副本，并补充 POST/PUT 能力。

### 阶段二 · 记忆补齐与回流
- 新增客户级会话摘要记忆：backend `customer_summaries.json` 存储 + `GET/PUT /api/customers/:id/summary` 接口。
- 网关侧摘要生成：会话每轮结束后按客户级节流（默认 10 分钟，env `FINANCE_SUMMARY_REFRESH_MS`）fire-and-forget 刷新，复用 `llm-json.ts` 原子调用。
- 主对话稳定前缀注入：`agent-session.ts` 通过 `DefaultResourceLoader.appendSystemPromptOverride` 在会话创建时注入「客户摘要 + 知识库精简 + 客户/经理标识」稳定前缀；**移除逐轮 `[会话上下文]` 消息前缀**（`stripContextPrefix` 保留用于展示旧历史）。
- 接通市场简报：backend 新增 `GET/PUT /api/market/brief`（`.runtime/data/market_brief.json`）；plan scope 取数时并发拉取（失败降级空串）；主对话新增 `market_query` 自定义工具。

### 阶段三 · 长会话与缓存
- 启用 Pi SDK compaction：`.pi/settings.json` `compaction.enabled: true`；`agent-session.ts` 订阅 `compaction_start/end` 事件打日志；新增 `POST /api/sessions/:sessionKey/compact` 手动压缩端点（支持 `customInstructions`）。
- 工具结果白名单截断：`product_query` 回灌文本只保留 productId/name/category/riskLevel/tenor/expectedReturn（去掉 minAmount/campaigns）。
- token 可观测：context-builder 序列化时输出估算 token；`message_end` 时记录 usage（若 SDK 消息携带）。

## Impact

- Affected code:
  - `finclaw/pi-gateway/src/workflow/`：新建 context-builder.ts、customer-summary.ts；改 types.ts、backend-client.ts、llm-leaf.ts、index.ts、insight-batch.ts、self-evolve.ts、prompts.ts（如需）
  - `finclaw/pi-gateway/src/tools/`：backend-http.ts（补 POST/PUT）、customer-analyze.ts（product_query 截断 + market_query 工具）
  - `finclaw/pi-gateway/src/`：agent-session.ts（稳定前缀 / 摘要刷新 / compaction）、handlers.ts + server.ts（compact 端点）
  - `finclaw/backend/src/`：store.mjs（customer_summaries + market_brief 读写）、routes/customers.routes.mjs（summary 接口）、market 路由 + index.mjs 注册
  - `finclaw/.pi/settings.json`（compaction.enabled）、`finclaw/.pi/AGENTS.md`（market_query 工具说明）
  - `finclaw/docs/data-dictionary.md`、`finclaw/docs/api-reference.md`（新增数据文件/端点/协议变更同步）
- 不改前端（请求协议与 SSE 事件不变）；`WorkflowContext.strategies` 改可选为 **BREAKING**（仅仓库内部类型，同步修正所有构造点）。

## 与最新团队代码（ab900020e，2026-08-16 洞察工作流）的兼容性核对

已拉取远端 `feature/refactor-workflow-impl` 最新代码并核对，结论为**无冲突，仅两处需在实现中注意**：

1. `GET /api/customers/:id/profile` 响应现已附加 `tasks`（策略任务）与合并 `tags`（见 `customers.routes.mjs`）。chat 稳定前缀的画像取数必须经白名单 pick（customerId/name/segment/riskTolerance/aum/lifeCycleStage/preferences），**天然排除 tasks/tags**，禁止整对象注入。
2. 洞察链路已全局化且与方案生成解耦（`scheduler.mjs`、`mergeTasksForCustomer`），本变更只改 `insight-batch.ts` 取数 scope，不触碰 scheduler 与增量过滤逻辑。
3. 团队有文档同步惯例（本次拉取即更新了 `data-dictionary.md`），故新增文档同步任务（见 MODIFIED Requirements）。

## ADDED Requirements

### Requirement: ContextBuilder 上下文组装单一出口
系统 SHALL 提供统一投影与序列化模块（context-builder.ts），方案链路注入模型前经白名单投影（products 只保留 productId/name/category/riskLevel/expectedReturn/tenor，剔除 strategies），并以紧凑 JSON（无缩进）序列化，超出预算时优先裁剪 knowledge/marketBrief。

#### Scenario: plan scope 投影
- **WHEN** 调用 `projectPlanContext` 输入含 strategies、campaigns、availableQuota 的完整 WorkflowContext
- **THEN** 输出不含 strategies，products 每项仅含 6 个白名单字段，customer 与 personalKnowledge、marketBrief 保留

#### Scenario: 紧凑序列化与日志
- **WHEN** 调用 `serializeLeafContext`
- **THEN** 返回无换行缩进的 JSON 字符串，并输出含估算 token 数的日志

### Requirement: fetchContext 按需取用
BackendClient.fetchContext SHALL 支持 scope 参数：`plan`（默认，画像+适配产品+知识库+市场简报，并发拉取，市场简报失败降级空串）与 `customer`（仅画像）；不再请求 strategies。

#### Scenario: customer scope
- **WHEN** insight/extract/knowledge 链路调用 `fetchContext(id, mgr, "customer")`
- **THEN** 仅发起 profile 一个 GET 请求

### Requirement: 客户级会话摘要记忆
backend SHALL 持久化客户摘要至 `.runtime/data/customer_summaries.json`（按 customerId 覆盖式更新），并提供 GET/PUT 接口；网关 SHALL 在主对话每轮结束后按客户节流刷新摘要（LLM 从会话消息 + 既有摘要提炼 preferences/adoptedPlans/concerns/opportunities/raw，raw ≤200 token），失败仅记日志不影响主流程。

#### Scenario: 摘要写入与读取
- **WHEN** 网关完成一次摘要提炼后 PUT `/api/customers/CUST_001/summary`
- **THEN** 后续 GET 返回该摘要；同客户再次 PUT 时旧摘要被覆盖

#### Scenario: 节流
- **WHEN** 同一客户 10 分钟内发生第二轮对话结束
- **THEN** 不触发第二次摘要 LLM 调用

### Requirement: 主对话稳定前缀注入
AgentSessionManager SHALL 在会话创建时拉取（画像白名单字段 + 客户摘要 + 知识库前 300 字符）构建稳定前缀，经 `appendSystemPromptOverride` 注入系统提示；本轮消息不再拼接 `[会话上下文]` 前缀；后端不可达时降级为仅含标识的极简前缀，不阻塞会话。

#### Scenario: 前缀注入
- **WHEN** 首次对某 sessionKey 调用 runPrompt
- **THEN** 系统提示尾部包含客户摘要与知识库节，用户消息为原文

### Requirement: 市场简报数据源
backend SHALL 提供 `GET/PUT /api/market/brief`（存储于 `.runtime/data/market_brief.json`，缺省空串）；plan scope 组装时注入 marketBrief；主对话提供 `market_query` 工具读取。

### Requirement: SDK compaction
`.pi/settings.json` SHALL 启用 compaction；网关 SHALL 订阅 compaction_start/end 事件并记录日志，提供 `POST /api/sessions/:sessionKey/compact`（可选 body `{customInstructions}`）手动压缩。

#### Scenario: 手动压缩
- **WHEN** POST `/api/sessions/{sessionKey}/compact`
- **THEN** 返回压缩结果，会话后续回放为「摘要 + 保留段原文」

## MODIFIED Requirements

### Requirement: 叶子 prompt 序列化
`llm-leaf.ts` buildPrompt 的业务上下文 JSON 注入 SHALL 改为投影后紧凑序列化；市场简报作为独立段落的行为保持。

### Requirement: 洞察/提取/自进化取数
`insight-batch.ts` 的 `createInsightDeps` 与 `self-evolve.ts` 两个函数 SHALL 改用 customer scope 取数（原先全量 4 并发）。

### Requirement: backend HTTP 基建复用
`workflow/backend-client.ts` SHALL 复用 `tools/backend-http.ts` 的配置与请求函数（新增 backendPost/backendPut 导出），删除重复的 loadConfig/buildHeaders/request。

### Requirement: product_query 回灌白名单
`product_query` 工具回灌文本 SHALL 仅包含 productId/name/category/riskLevel/tenor/expectedReturn 字段与分页提示。

### Requirement: 文档同步
实现 SHALL 同步更新 `finclaw/docs/data-dictionary.md`（运行时数据表新增 customer_summaries.json / market_brief.json，WorkflowContext.strategies 改可选与 fetchContext scope 说明，SSE 协议章节移除「[会话上下文] 前缀注入」描述改为稳定前缀注入，环境变量表新增 FINANCE_SUMMARY_REFRESH_MS）与 `finclaw/docs/api-reference.md`（新增 GET/PUT /api/customers/:id/summary、GET/PUT /api/market/brief、POST /api/sessions/:sessionKey/compact）。

## REMOVED Requirements

### Requirement: 逐轮 [会话上下文] 消息前缀
**Reason**: 稳定前缀迁移到系统提示层（appendSystemPromptOverride），避免污染动态段、提升前缀缓存命中。
**Migration**: `runPrompt` 直接发送原文消息；`session-aggregate.ts` 的 `stripContextPrefix` 保留以兼容已存在的历史会话文件。

### Requirement: strategies 全量拉取
**Reason**: 方案引擎与洞察链路均不消费 strategies 文本，属超发取数。
**Migration**: `WorkflowContext.strategies` 改为可选字段，fetchContext 不再请求 `/api/products/strategies`；同步修正受影响测试。
