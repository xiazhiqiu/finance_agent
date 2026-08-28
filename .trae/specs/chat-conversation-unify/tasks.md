# Tasks

## 阶段一 · 后端会话模型（可并行）

- [x] Task 1: PlanSession 增加 sessionKey 字段
  - [x] 1.1 `backend/src/store.mjs`：`createPlanSession` / `updatePlanSession` / 数据读写支持 `sessionKey` 字段
  - [x] 1.2 `backend/src/routes/sessions.routes.mjs`：PUT 允许更新 `sessionKey`
  - 验证：`node --test` 通过（5/5）；新增 sessionKey 后可读回

- [x] Task 2: pi-gateway 历史会话读取接口
  - [x] 2.1 `pi-gateway/src/agent-session.ts`：暴露按 sessionKey/sessionDir 读取历史消息的方法（`SessionManager.list` / `open` + `parseSessionEntries`）
  - [x] 2.2 `pi-gateway/src/handlers.ts` + `server.ts`：新增 `GET /api/sessions`（列表：id/首条消息/消息条数/最后活动时间）与 `GET /api/sessions/{id}/messages`（完整消息列表）
  - 验证：`tsc` / `vitest run`（25/25）通过

## 阶段二 · workflow 引擎支持可选上下文

- [x] Task 3: workflow 支持可选 context 参数
  - [x] 3.1 `pi-gateway/src/workflow/`：`WorkflowRequest` 扩展可选 `context`；`runGeneratePlan` / `runOptimizePlan` 在 context 提供时直接用，否则照旧完整拉取（customer/profile/products/knowledge/market）
  - 验证：`vitest run`（orchestrator 14/14 通过，新增提供/未提供 context 两组用例，前者断言不调 `fetchContext`）

## 阶段三 · 自定义工具化（依赖 Task 3）

- [x] Task 4: 新增 generate_plan / optimize_plan 自定义工具
  - [x] 4.1 `pi-gateway/src/tools/`：新增方案工具（plan-tools.ts），包装 workflow（`runGeneratePlan` / `runOptimizePlan`），参数含 `customer_id`、`manager_id?`、`target_plan_id?`、`instruction?`、`context?`，返回 `GenerateResult`
  - [x] 4.2 在 `createCustomTools()` 中注册上述工具
  - 验证：单测/手动触发工具返回 GenerateResult（plan-tools.test.ts 4 项通过）

## 阶段四 · 前端对话界面（依赖 Task 2/4）

- [x] Task 5: 会话 key 与发送协议切换
  - [x] 5.1 `web/src/main.ts` / `advisor-gateway.ts`：sessionKey 按会话生成（含 planSessionId）；发送改为自由聊天文本（不再传 `{action,payload}` workflow 消息）
  - [x] 5.2 SSE 消费：`thinking` / `tool_call` / `tool_result` / `message` / `final` 事件流式处理
  - 验证：`tsc` / `vite build` 通过

- [x] Task 6: 对话界面渲染（头像+气泡+流式）+ 快捷按键自动发送
  - [x] 6.1 右栏 agent 面板改为多轮对话列表：用户气泡（右侧/经理头像）与 Agent 气泡（左侧/品牌头像）交替；Agent 气泡流式输出文本，工具执行时显示状态提示
  - [x] 6.2 快捷按键（分析客户/市场分析/生成方案）点击 = 插入对应指令文本的用户气泡并自动发送，不再直接执行生成逻辑
  - 验证：浏览器手动验证（由开发者执行）；`tsc` / `vite build` 通过

- [x] Task 7: 方案卡片内嵌 Agent 气泡（tool_result 渲染）
  - [x] 7.1 监听 `tool_result`，toolName 为 generate_plan/optimize_plan 时用 `GenerateResult` 渲染气泡内方案卡片（保留对比/选择/详情/发送交互）
  - 验证：生成/优化后卡片出现在 Agent 气泡内

- [x] Task 8: 历史会话列表改进与进入对话
  - [x] 8.1 现有 switcher 面板增强：显示 标题/最后消息预览/消息条数/方案数/时间；保留 切换/删除/新建
  - [x] 8.2 点击历史会话 = 经 pi-gateway 读取该会话 Pi SDK 消息，加载完整对话气泡 + 方案卡片
  - [x] 8.3 切换客户自动继续该客户最新会话对话；无历史则空白对话；首次发送惰性创建会话
  - 验证：刷新后从历史列表进入可回看完整对话

## 阶段五 · 收尾与验证

- [x] Task 9: 全量验证
  - [x] 9.1 `node --test`（backend）5/5 通过
  - [x] 9.2 `vitest run`（pi-gateway 32/32、web 2/2 通过）
  - [x] 9.3 `tsc` 与 `vite build` 通过
  - 验证：以上全部通过

# Task Dependencies
- [Task 4] depends on [Task 3]
- [Task 5] depends on [Task 4]
- [Task 6] depends on [Task 5]
- [Task 7] depends on [Task 5]
- [Task 8] depends on [Task 2, Task 6]
- [Task 9] depends on [Task 1, Task 2, Task 4, Task 6, Task 7, Task 8]
- [Task 1] 与 [Task 2] 相互独立，可并行
