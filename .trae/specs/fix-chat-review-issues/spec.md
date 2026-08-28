# 代码审查问题修复 Spec

## Why

代码审查（Standards 轴 + Spec 轴）发现上一轮 chat-conversation-unify 实现存在 6 类 Standards 问题（死代码残留、重复代码、魔串、handler 尾部换行）和 7 类 Spec 偏差（context 字段不对齐、会话无客户上下文、优化非默认经理 403、最后消息预览缺失、标题非首条指令、sessionKey agentId 硬编码、workflow 死通道残留）。修复以上问题，确保代码库健康。

## What Changes

- **死代码清理**：移除 `showSessionSwitcher` 字段和 `toggle-session-switcher` handler；删除 styles.css 中被删组件的遗留样式（`.session-switcher`、`.optimization-input`、`.plan-ref-card` 等）
- **Context 字段对齐 spec**：工具 context 字段改为 `customer_profile`/`eligible_products`/`personal_knowledge`/`market_brief`/`previous_plans`；移除 `strategies`；`WorkflowContext` 新增可选 `marketBrief` 字段
- **会话上下文注入**：前端发送消息时捎带 `customer_id`/`manager_id`；后端每轮消息前拼接客户/经理上下文到 Agent 消息，使 Agent 知道当前客户和经理，`generate_plan`/`optimize_plan` 能正确传参
- **优化非默认经理 403 修复**：`findPlanFromBackend` 请求后端列表时附加当前会话该客户的 `x-manager-id` 绕过鉴权（scheduler 已有 `x-internal-token` 模式）
- **最后消息预览**：`listSessions` 返回新增 `lastMessage` 字段；`sessionCardHtml` 预览改为最后一条消息
- **标题修复**：`sessionCardHtml` 标题从 `s.title` 改为首条用户消息（`gatewaySessionFor.title` 保底）
- **sessionKey agentId 动态化**：`store.mjs` 的 sessionKey 中 `agentId` 从写死的 `wealth-advisor` 改为 `process.env.FINANCE_AGENT_ID` 环境变量读入，默认 `wealth-advisor`；`safeKey` 归一化提取为共享函数
- **Workflow 死通道移除**：删除 `handlers.ts` 的 `handleWorkflow` 函数和 `handleAgentRun` 中的 workflow JSON 分流逻辑
- **重复代码抽取**：`loadConfig`/`backendGet` 抽取为共享 `backend-http.ts` 模块；`safeKey` 归一化抽取为共享函数；`main.ts` 中三处重复的会话装载块抽取为 `applySession()` 方法
- **handler 尾部换行修复**：`handlers.ts` 文件尾补换行
- **findPlanFromBackend 保留并记录理由**：将其加入 spec.md 说明为优化功能的必要实现

## Impact

- Affected specs: chat-conversation-unify（修复对齐）
- Affected code:
  - `web/src/main.ts`（死代码、会话装载抽取、会话上下文前端部分）
  - `web/src/styles.css`（死样式清理）
  - `web/src/types.ts`（无变化）
  - `web/src/advisor-gateway.ts`（发送消息时捎带 customerId/managerId）
  - `pi-gateway/src/agent-session.ts`（会话上下文注入，listSessions 新增 lastMessage）
  - `pi-gateway/src/handlers.ts`（移除 workflow 死通道，新 handler 接口）
  - `pi-gateway/src/server.ts`（无变化，旧路由已移除）
  - `pi-gateway/src/tools/plan-tools.ts`（context 字段对齐，shared backend 模块引用）
  - `pi-gateway/src/tools/customer-analyze.ts`（使用 shared backend 模块）
  - `pi-gateway/src/tools/`（新增 backend-http.ts 共享模块）
  - `pi-gateway/src/workflow/types.ts`（WorkflowContext 新增 marketBrief）
  - `pi-gateway/src/workflow/orchestrator.ts`（context 变更影响取数，marketBrief 生产 prompt）
  - `pi-gateway/src/workflow/llm-leaf.ts`（marketBrief 注入 LLM prompt）
  - `pi-gateway/src/workflow/backend-client.ts`（fetchContext 返回 marketBrief）
  - `backend/src/store.mjs`（sessionKey agentId 动态化）
  - `backend/src/routes/sessions.routes.mjs`（无变化）
  - `pi-gateway/src/workflow/index.ts`（导出 marketBrief 类型）

## ADDED Requirements

### Requirement: 共享 HTTP 模块

系统 SHALL 将 `loadConfig`/`backendGet`/`findPlanFromBackend` 抽取为共享模块 `tools/backend-http.ts`，`customer-analyze.ts` 和 `plan-tools.ts` 统一引用。

### Requirement: safeKey 共享函数

系统 SHALL 将 `sessionKey.replace(/[^a-zA-Z0-9_-]/g, "-")` 归一化逻辑抽取为共享函数，供 `agent-session.ts` 和 `main.ts` 统一引用。

### Requirement: 会话上下文注入

前端发送消息时 SHALL 在 body 中捎带 `customer_id` 和 `manager_id`；后端 `agent-session.ts` 的 `runPrompt` SHALL 在每轮消息前拼接客户/经理上下文(`[customer: xxx, manager: xxx]`)到 Agent 消息。

### Requirement: lastMessage 字段

`listSessions` 返回的 `SessionSummary` SHALL 新增 `lastMessage` 字段（最近一条消息内容预览），`sessionCardHtml` 的预览文本 SHALL 使用最后消息而非首条指令。

### Requirement: sessionKey agentId 动态化

`store.mjs` 的 sessionKey 模板 SHALL 从 `process.env.FINANCE_AGENT_ID` 读取 agentId，缺省值为 `wealth-advisor`。

## MODIFIED Requirements

### Requirement: Context 字段对齐

`plan-tools.ts` 工具 context 字段改为 `customer_profile`/`eligible_products`/`personal_knowledge`/`market_brief`/`previous_plans`；移除 `strategies`；`WorkflowContext` 新增可选 `marketBrief: string` 字段；`fetchContext` 从后端返回 `marketBrief`（市场分析结果）；`normalizeContext` 对应映射。

### Requirement: Workflow 死通道移除

`handlers.ts` 的 `handleAgentRun` 中识别 workflow JSON 并分流的逻辑（`handleWorkflow` 函数）SHALL 移除。前端已全部走自由聊天，不再需要此兜底。

### Requirement: 优化非默认经理 403 修复

`findPlanFromBackend` SHALL 传入当前实际 `managerId` 而非 `MGR_001`；后端 `sessions.routes.mjs` 的鉴权 SHALL 对携带 `x-internal-token` 的请求跳过鉴权（scheduler 已有此模式，但 `findPlanFromBackend` 来自 pi-gateway 的 fetch 未携带）。

## REMOVED Requirements

### Requirement: showSessionSwitcher 字段及 toggle-session-switcher handler

**Reason**: `sessionSwitcherHtml()` 已在前一轮重构中删除，但字段和 handler 残留。
**Migration**: 移除 `showSessionSwitcher` 字段声明和 `toggle-session-switcher` action 分支。

### Requirement: workflow JSON 分流通道

**Reason**: 前端已全部走纯文本自由聊天，不再需要 `handleAgentRun` 中识别 `{action,payload}` JSON 的兜底。
**Migration**: 删除 `handleWorkflow` 函数和 `handleAgentRun` 中的 JSON 解析分流逻辑。