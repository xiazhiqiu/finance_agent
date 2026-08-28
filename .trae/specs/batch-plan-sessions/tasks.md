# Tasks

## Task 1: gateway 会话内方案生成编排
在 pi-gateway 新增「在指定正式会话内生成方案」能力，捕获 `generate_plan`/`optimize_plan` 工具结果并写入会话历史。
- [x] 1.1 新增编排函数 `runPlanInSession(sessionKey, instruction, context, sessionManager)`：调用 `sessionManager.runPrompt`，通过 `onToolResult` 捕获 `details.result`（`{ plans, complianceReport }`），记录 finalText，失败转为 error 字段不向上抛
- [x] 1.2 新增批量接口 handler `handleSessionsBatchPlan`（`POST /api/sessions/batch-plan`）：接收 items，逐条字段校验，受控并发（复用 `BATCH_PLAN_CONCURRENCY`，缺省 6）执行 `runBatchPlanInSessions`，单会话失败隔离进 error
- [x] 1.3 在 server.ts 注册路由 `POST /api/sessions/batch-plan`（位于 404 之前）
- [x] 1.4 验证：`plan-in-session.test.ts` 5 用例通过；`pnpm test` 全量 12 文件 / 106 用例通过；`tsc` 通过

## Task 2: backend 批量预开会话 + 并行调用 + 落库
改造 `scheduler.mjs` 的批量方案阶段为「预开会话 → 会话内生成 → 落 plan_sessions」。
- [x] 2.1 初始生成指令**复用前端现有「请为该客户生成一套营销方案」**，不自造提示词
- [x] 2.2 重写 `runBatchPlansStage`：逐客户 `createPlanSession` 预开会话（标题带客户名/日期）→ 分批并发调用 `callGatewayBatchPlan` → 成功 `updatePlanSession(sessionId, { plans, complianceReport })`，失败记入 `failures` 且不牵连其余 → 实时 `updateBatchJob` 进度
- [x] 2.3 删除 `callGatewayWorkflow`（`/api/workflow/run` 批量调用），新增 `callGatewayBatchPlan`（`/api/sessions/batch-plan`）
- [x] 2.4 `BATCH_PLAN_CONCURRENCY` 默认并发 3 → 6（环境变量仍可覆盖）
- [x] 2.5 验证：`node --check src/scheduler.mjs` 通过；`node --test` 12 用例通过

## Task 3: 端到端验证
- [x] 3.1 批量方案生成链路已实现并静态审查（预开会话→并发生成→落库→job 记录）
- [x] 3.2 历史对话可见路径已打通（方案与合规落 plan_sessions；生成对话写 .pi/sessions；前端打开即以该会话为最新可续聊优化）
- [x] 3.3 失败隔离与可重试已实现（预开会话失败/网关整批失败/单条失败均独立记录、不牵连其余）
- [ ] 3.4 手动触发 e2e（浏览器真实 LLM 运行，含合规待处理与失败重试）——交由开发者在真实环境验证

# Task Dependencies
- Task 2 依赖 Task 1（gateway 接口就绪）
- Task 3 依赖 Task 2