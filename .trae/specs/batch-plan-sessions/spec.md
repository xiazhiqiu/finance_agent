# 批量方案生成：自动预开会话并行执行 Spec

## Why

当前手动静默批量方案生成走非流式 `workflow/run`，只产出方案 JSON 并更新 job 计数，既不创建 backend `plan_sessions` 条目，也不写 pi-gateway 正式会话历史（`.pi/sessions/`）。因此前端点击客户查看历史对话为空，且批量产出的方案无法在同一会话上下文上续聊优化；后续优化需重新初始化会话与取数，初始生成时间成本高。

将批量方案生成改造为「自动预开会话 + 并行执行 + 方案落会话历史」，使批量产出的方案直接进入客户的正式会话，前端可查看并直接续聊优化，缩短初始方案生成时间成本。

## What Changes

- **gateway 新增「会话内方案生成」编排**：在给定 `sessionKey` 的正式 AgentSession 内 `runPrompt`，通过事件订阅捕获 `generate_plan` / `optimize_plan` 工具结果（`GenerateResult`，含 `plans` + `compliance`），SDK 自然把 指令 + 工具调用 + 工具结果 + assistant 文本 写入 `.pi/sessions/<safeKey>/*.jsonl`。
- **gateway 新增批量会话内生成接口**：接收一组 `{ sessionKey, customerId, managerId, instruction }`，支持并发（受控）在各自会话内并行生成，返回每个会话的 `GenerateResult`；单个会话失败不牵连其他。
- **backend `runBatchPlansStage` 改造**：
  - 逐客户 `createPlanSession` 预开会话，取得 `sessionId`/`sessionKey`；
  - 并行调用 gateway 会话内生成接口；
  - 用 `updatePlanSession` 将返回的 `plans`/`compliance` 写入 plan_sessions（与前端路径一致）；
  - 单客户失败隔离，独立记录可重试；实时更新 job 进度。
  - 初始生成指令**复用前端现有「请为该客户生成一套营销方案」**，方案生成与会话管理全部复用现有逻辑，不自造提示词。
- **提高默认并发**：`BATCH_PLAN_CONCURRENCY` 默认值从 3 提升（仍可由环境变量覆盖，保留下游限流保护）。
- 方案照常强制合规审查（`generate_plan` 工具内部已含）；未能通过合规的标「待处理」进提醒区。
- **BREAKING**：不再使用 `/api/workflow/run`（`generate_plans`）作为批量入口；删除 backend `callGatewayWorkflow` 对应调用。

## Impact

- Affected specs: `optimize-insight-workflow`、`chat-conversation-unify`（会话 / 方案快照关系）
- Affected code:
  - `finclaw/pi-gateway/src/workflow/`（复用 `runGeneratePlan` / `createWorkflowDeps` 与新编排）
  - `finclaw/pi-gateway/src/agent-session.ts`（会话内运行与工具结果捕获）
  - `finclaw/pi-gateway/src/handlers.ts`、`server.ts`（新接口注册）
  - `finclaw/backend/src/scheduler.mjs`（批量编排改造、并发默认值）
  - `finclaw/backend/src/store.mjs`（复用 `createPlanSession` / `updatePlanSession`，无需新存储）

## ADDED Requirements

### Requirement: 批量预开会话并并行生成方案

系统 SHALL 在手动批量方案生成时，为每个目标客户预创建 backend PlanSession，并在对应正式 AgentSession 内并行生成方案，使方案进入该会话历史并落库到 plan_sessions，供前端查看与后续优化。

#### Scenario: 成功场景
- **WHEN** 用户多选客户点击「方案生成」
- **THEN** 每个客户产生一个含方案的历史会话：`plan_sessions` 出现新条目（`plans` + `compliance`），pi-gateway 会话历史包含生成对话；前端打开该客户即以该会话为最新会话，可查看方案并续聊优化；批量 job 标记完成。

#### Scenario: 单客户失败隔离
- **WHEN** 某个客户方案生成失败
- **THEN** 该客户失败被记录在 job `failures`、独立标记可重试，不影响其余客户成功落库；job 进度正确反映成功/失败数。

#### Scenario: 合规未通过
- **WHEN** 某客户生成的方案未通过合规审查
- **THEN** 该方案不进入前台方案卡片，标记「待处理」，可出现在提醒区，客户可单独重试。

#### Scenario: 历史对话可见
- **WHEN** 批量生成成功后点击该客户查看历史对话
- **THEN** 能读到批量初始化指令、生成对话与方案内容（来自 pi-gateway 会话历史），且方案卡片（来自 plan_sessions）正常渲染。

## MODIFIED Requirements

### Requirement: 批量并发度
系统 SHALL 支持通过环境变量 `BATCH_PLAN_CONCURRENCY` 控制批量方案生成的并发数，默认值由 3 提高以缩短初始方案生成时间，保留下游限流保护能力。
- **WHEN** 未显式配置该变量
- **THEN** 使用提高后的默认并发值并行执行批量生成。

## REMOVED Requirements

### Requirement: 非流式 workflow 批量方案入口
**Reason**: 非流式 `/api/workflow/run`（`generate_plans`）不产生会话历史，导致批量方案无法进入客户会话与后续优化。
**Migration**: 批量入口改为「预开会话 + 会话内 runPrompt 生成」，复用 `runGeneratePlan`/`createWorkflowDeps` 内核；非流式接口对单客户生成仍保留供其它调用方使用。