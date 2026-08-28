# 对话界面统一改造 Spec

## Why
右栏 agent 面板目前是"快捷按键直接执行逻辑 + 方案卡片列表"，所有消息走 TS 编排引擎，Pi SDK 自由聊天通道未用；会话上下文按"经理-客户"单一复用，历史会话入口（PlanSession 切换器）体验差。目标是把右栏改造为多轮对话聊天界面，统一走 Pi SDK 自由聊天，方案生成/优化包装为工具，会话按"对话"粒度隔离、上下文与持久化由 Pi SDK 管理。

## What Changes
- 右栏 agent 面板改为多轮对话聊天界面（头像+气泡交替），所有对话（手动输入 + 快捷按键）以气泡记录
- 快捷按键逻辑改为"自动发送指令"（插入用户气泡并发送），不再直接执行生成逻辑
- 所有消息统一走 Pi SDK `AgentSession` 自由聊天；方案生成/优化注册为自定义工具 `generate_plan` / `optimize_plan`（可选 `context` 参数）
- 前端监听 SSE `tool_result` 事件渲染方案卡片（内嵌于 Agent 气泡，保留对比/选择/详情/发送交互）
- 会话模型统一：一次对话会话 = 后端 `PlanSession`（业务数据）+ Pi SDK `AgentSession`（对话上下文），通过 `sessionKey` 绑定；sessionKey 按会话生成
- pi-gateway 新增历史会话读取接口（`SessionManager.list` / `SessionManager.open` + `parseSessionEntries`）
- 现有历史会话 switcher 面板改造（标题/最后消息预览/消息条数/方案数/时间，保留切换/删除/新建）
- **BREAKING**: sessionKey 从"每经理-客户一个"改为"每会话一个"；前端发送协议从 `{action,payload}` workflow 改为自由聊天消息

## Impact
- Affected specs: pi-gateway 的 agent 会话管理、workflow 引擎、web 交互
- Affected code:
  - `web/src/main.ts`（对话界面、快捷按键、消息/方案卡片渲染）
  - `web/src/advisor-gateway.ts`（发送协议、SSE 事件消费）
  - `web/src/api.ts`、`web/src/types.ts`（历史会话读取、PlanSession 增加 sessionKey）
  - `pi-gateway/src/agent-session.ts`、`handlers.ts`、`server.ts`（会话管理、历史读取接口、事件透传）
  - `pi-gateway/src/tools/*`（新增 generate_plan/optimize_plan 工具）
  - `pi-gateway/src/workflow/*`（可选 context 参数支持）
  - `backend/src/routes/sessions.routes.mjs`、`backend/src/store.mjs`（PlanSession 增加 sessionKey 字段）

## ADDED Requirements

### Requirement: 多轮对话聊天界面
系统 SHALL 将右栏 agent 面板渲染为多轮对话聊天界面，以"头像+气泡"交替记录所有对话（手动输入与快捷按键触发）。

#### Scenario: 用户发送消息
- **WHEN** 用户输入指令并发送，或点击快捷按键
- **THEN** 用户气泡（右侧、经理头像）先出现，Agent 气泡（左侧、品牌头像）流式输出回复；有方案生成时，方案卡片内嵌于 Agent 气泡

### Requirement: 快捷按键自动发送指令
快捷按键 SHALL 将对应指令文本作为用户气泡插入对话并自动发送，而不是直接执行生成逻辑。

#### Scenario: 点击快捷按键
- **WHEN** 用户点击"分析客户 / 市场分析 / 生成方案"
- **THEN** 一条用户气泡显示对应指令文本并自动发送；Agent 依据会话上下文与技能/工具回复

### Requirement: 统一走 Pi SDK 自由聊天与上下文管理
所有对话消息 SHALL 经 `AgentSessionManager` 走 Pi SDK `AgentSession`；多轮上下文（含"上一轮方案"等指代）由 Pi SDK 会话管理，前端/后端不再手动传递 `previous_plans` 等上下文。

#### Scenario: 指代上一轮方案
- **WHEN** 用户发送"把方案A的权益比例降低到 20%"
- **THEN** Agent 从会话上下文识别目标方案并调用 `optimize_plan` 工具完成优化

### Requirement: 方案生成/优化包装为自定义工具
系统 SHALL 将方案生成与优化包装为 Pi SDK 自定义工具 `generate_plan(customer_id, manager_id?, context?)` 与 `optimize_plan(customer_id, manager_id?, target_plan_id?, instruction?, context?)`；`context` 为可选字段（`customer_profile` / `eligible_products` / `personal_knowledge` / `market_brief` / `previous_plans`），传入时 workflow 直接用，不传则完整跑 workflow；工具返回现有 `GenerateResult`（plans + compliance）供渲染。

#### Scenario: 传入上下文
- **WHEN** 工具调用携带 `context` 字段
- **THEN** workflow 使用给定上下文，不再重新拉取客户/产品/知识/市场数据

#### Scenario: 未传上下文
- **WHEN** 工具调用未携带 `context`
- **THEN** workflow 完整拉取数据并生成方案

### Requirement: 前端基于 tool_result 渲染方案卡片
前端 SHALL 监听 SSE `tool_result` 事件，当 `toolName` 为 `generate_plan` / `optimize_plan` 时，用工具返回的 `GenerateResult` 渲染 Agent 气泡内方案卡片（保留对比/选择/详情/一键发送交互），Agent 的自然语言总结显示在卡片上方。

### Requirement: 会话模型统一
系统 SHALL 将一次对话会话定义为后端 `PlanSession`（业务数据：plans/selectedPlanId/lastInstruction/complianceReport）+ Pi SDK `AgentSession`（对话上下文），通过新增 `sessionKey` 字段绑定；sessionKey 按会话生成（形如 `agent:{agentId}:finance:direct:{managerId}-{customerId}-{planSessionId}`）；每次生成/优化，方案 JSON 作为该轮对话的工具结果随 Pi SDK 会话持久化（历史回看可还原），后端 `PlanSession` 保留最新一套方案供发送/合规/导出。

### Requirement: 历史会话持久化与读取
pi-gateway SHALL 提供历史会话读取能力：`GET /api/sessions`（`SessionManager.list`）与 `GET /api/sessions/{sessionId}/messages`（`SessionManager.open` + `parseSessionEntries`）；刷新页面后可从历史列表重新进入完整对话。

#### Scenario: 刷新后回看历史
- **WHEN** 用户刷新页面后从历史会话列表点击某会话
- **THEN** 加载该会话的对话气泡与方案卡片

### Requirement: 历史会话列表改进
系统 SHALL 改造现有历史会话 switcher 面板：卡片显示 标题(首条指令)/最后消息预览/消息条数/方案数/时间，保留 切换/删除/新建；点击卡片打开该会话完整对话。

### Requirement: 切换客户自动继续最新会话
切换客户 SHALL 自动继续该客户最新会话的对话（无历史则空白对话）；首次发送时惰性创建会话。

## MODIFIED Requirements

### Requirement: 方案生成/优化原 workflow 通道
原前端直接调用 `{action: generate_plans / optimize_plan}` 的 workflow 通道改为经 Pi SDK 自由聊天 + 工具方式调用；后端 workflow 引擎保留，并支持可选 `context` 参数直接使用给定上下文。

### Requirement: 会话切换器
原 `PlanSession` 切换器（标题/方案数/时间/切换/删除/新建）保留并增强 最后消息预览/消息条数 等字段，点击进入完整对话。

## REMOVED Requirements

### Requirement: 快捷按键直接执行生成逻辑
**Reason**: 用户要求快捷按键改为"自动发送指令"，进入统一对话流。
**Migration**: 快捷按键点击改为发送对应指令文本（用户气泡），由 Agent 会话处理。
