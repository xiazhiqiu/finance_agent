# Tasks

## 阶段一 · 清理与共享模块（可并行）

- [x] Task 1: 死代码清理
  - [x] 1.1 `web/src/main.ts`：移除 `showSessionSwitcher` 字段及所有赋值、`toggle-session-switcher` action 分支
  - [x] 1.2 `web/src/styles.css`：删除 `.session-switcher`、`.session-list*`、`.optimization-input`、`.generation`、`.plan-ref-card/.prf-*` 等被删组件遗留样式
  - 验证：`tsc`（pi-gateway）/ `vite build`（web）通过；Grep 确认无残留引用

- [x] Task 2: 抽取共享 Backend HTTP 模块与 safeKey 函数
  - [x] 2.1 新增 `pi-gateway/src/tools/backend-http.ts`：`loadConfig`（读 `FINANCE_API_URL`/`FINANCE_INTERNAL_TOKEN`）、`backendGet<T>(path, managerId, token?)`、`findPlanFromBackend(customerId, managerId, targetPlanId)`，支持 `x-internal-token` 请求头
  - [x] 2.2 `customer-analyze.ts` 与 `plan-tools.ts` 移除本地重复实现，改引用共享模块
  - [x] 2.3 新增 `pi-gateway/src/tools/safe-key.ts`（或并入 backend-http.ts）：`safeKey(sessionKey)` 归一化；`agent-session.ts` 改用
  - [x] 2.4 `web/src/main.ts`：`gatewaySessionFor` 使用一致的 `safeKey` 工具函数（可放 web 侧 util 文件）
  - 验证：`tsc` / `vitest run`（plan-tools.test.ts 与 customer 相关测试通过）；Grep 确认无重复定义

## 阶段二 · Context 字段对齐 spec（依赖 Task 2）

- [x] Task 3: 工具 context 字段对齐 spec
  - [x] 3.1 `pi-gateway/src/workflow/types.ts`：`WorkflowContext` 新增可选 `marketBrief?: string`；导出类型
  - [x] 3.2 `plan-tools.ts`：context 字段改为 `customer_profile`/`eligible_products`/`personal_knowledge`/`market_brief`/`previous_plans`（移除 `strategies`）；`normalizeContext` 映射到 `WorkflowContext`（customer_profile→customer 等，market_brief→marketBrief）
  - [x] 3.3 `backend-client.ts` `fetchContext`：返回 `marketBrief`（调用市场分析接口或留空字符串）
  - [x] 3.4 `llm-leaf.ts` `buildPrompt`：context 含 `marketBrief` 时注入"市场简报"节
  - 验证：`tsc` / `vitest run`（orchestrator.test.ts、plan-tools.test.ts 通过）；plan-tools.test.ts 新增 context 映射断言

## 阶段三 · 会话上下文与优化 403（可并行，部分依赖 Task 2）

- [x] Task 4: 会话上下文注入
  - [x] 4.1 `web/src/advisor-gateway.ts`：`sendChat` body 捎带可选 `customer_id`/`manager_id`
  - [x] 4.2 `web/src/main.ts`：调用 `sendChat` 时传入当前 `this.customer.customerId` 与 `this.user?.managerId`
  - [x] 4.3 `pi-gateway/src/handlers.ts`：`handleAgentRun` 读取 body 中可选 `customer_id`/`manager_id` 并传给 `runPrompt`
  - [x] 4.4 `pi-gateway/src/agent-session.ts`：`runPrompt` 增加可选上下文参数，每轮在用户消息前拼接 `[会话上下文] 当前客户 ... / 当前经理 ...`
  - 验证：`tsc` / `vitest run` 通过；SSE 无破坏（事件顺序不变）

- [x] Task 5: 优化非默认经理 403 修复
  - [x] 5.1 `backend/src/routes/sessions.routes.mjs`：GET /api/sessions 列表鉴权，当请求头含 `x-internal-token`（匹配配置）时跳过 `getAssignedCustomers` 校验（对齐 scheduler 的 internal token 模式）
  - [x] 5.2 `plan-tools.ts`/`backend-http.ts` `findPlanFromBackend`：请求携带 `x-internal-token`（若配置）与 `x-manager-id`
  - 验证：`node --test`（backend）通过；Grep 确认 scheduler 与 findPlanFromBackend 均走 internal token

## 阶段四 · 会话卡片与 sessionKey（可并行）

- [x] Task 6: 历史会话卡片改进（最后消息预览 + 标题首条指令）
  - [x] 6.1 `agent-session.ts` `listSessions`：`SessionSummary` 新增 `lastMessage`（最后一条消息文本预览）
  - [x] 6.2 `web/src/types.ts`：`GatewaySessionSummary` 增加 `lastMessage?: string`
  - [x] 6.3 `web/src/main.ts` `sessionCardHtml`：标题用 `gatewaySessionFor(s).title || s.title`，预览用 `gw.lastMessage || s.lastInstruction`
  - 验证：`tsc` / `vite build` 通过

- [x] Task 7: sessionKey agentId 动态化
  - [x] 7.1 `backend/src/store.mjs`：sessionKey 模板中 agentId 改为 `process.env.FINANCE_AGENT_ID || "wealth-advisor"`
  - 验证：`node --test`（backend）通过；Grep 确认无写死

## 阶段五 · 收尾（依赖 Task 1-7）

- [x] Task 8: Workflow 死通道移除 + handler 换行
  - [x] 8.1 `handlers.ts`：删除 `handleWorkflow` 函数与 `handleAgentRun` 中的 JSON 分流逻辑（保留自由聊天路径与 `handleWorkflowSync`）
  - [x] 8.2 `handlers.ts`：文件尾补换行
  - 验证：`tsc` / `vitest run`（pi-gateway 32/32）通过；`handleWorkflowSync` 仍被 `server.ts` 与 backend scheduler 使用

- [x] Task 9: 全量验证
  - [x] 9.1 `node --test`（backend）全部通过
  - [x] 9.2 `vitest run`（pi-gateway、web）全部通过
  - [x] 9.3 `tsc --noEmit`（pi-gateway）与 `vite build`（web）通过
  - 验证：以上全部通过

- [x] Task 10: 修复核验发现的 web/src/main.ts 缺陷（验证阶段发现）
  - [x] 10.1 补 `import { safeKey } from "./safe-key.ts"`（main.ts L723 使用 safeKey 但未导入，vite build 不报错但运行时抛 ReferenceError）
  - [x] 10.2 `sendChat` 调用处补传第 4 个 context 参数 `{ customerId: this.customer?.customerId, managerId: this.user?.managerId }`（否则客户/经理标识永远注入不到 Agent）
  - 验证：`vite build`（web）通过；Grep 确认 import 与 context 参数均存在

# Task Dependencies
- [Task 3] depends on [Task 2]
- [Task 5] depends on [Task 2]
- [Task 8] depends on [Task 1, Task 2, Task 3, Task 4, Task 5, Task 6, Task 7]
- [Task 9] depends on [Task 1, Task 2, Task 3, Task 4, Task 5, Task 6, Task 7, Task 8]
- [Task 1] 与 [Task 2] 相互独立，可并行
- [Task 4] 与 [Task 5] 相互独立，可并行
- [Task 6] 与 [Task 7] 相互独立，可并行