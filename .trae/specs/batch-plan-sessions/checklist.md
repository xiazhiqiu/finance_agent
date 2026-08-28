# Checklist

- [x] gateway 新增 `runPlanInSession`：在指定正式会话内 runPrompt，捕获 `generate_plan`/`optimize_plan` 的 `GenerateResult`（plans + complianceReport），生成对话写入 `.pi/sessions` 历史
- [x] gateway 批量会话内生成接口 `POST /api/sessions/batch-plan` 已注册，受控并发、单会话失败隔离（逐条校验 + 整批绝不 reject）
- [x] backend `runBatchPlansStage` 为每目标客户 `createPlanSession` 预开会话，并取到 `sessionId`/`sessionKey`
- [x] backend 并行调用 gateway 批量接口，成功者 `updatePlanSession(sessionId, { plans, complianceReport })` 落库
- [x] 单客户失败记录于 job `failures` 且独立可辨识，不影响其余客户（含预开会话失败、网关整批失败、单条失败）
- [x] 已移除 `callGatewayWorkflow`（非流式 `/api/workflow/run` 批量入口），新增 `callGatewayBatchPlan`
- [x] `BATCH_PLAN_CONCURRENCY` 默认并发值 3 → 6，环境变量仍可覆盖
- [x] 合规结果随方案写入 `complianceReport` 落库，由前端既有逻辑标记「待处理」、不进入前台方案卡
- [x] 手动触发批量后：每个客户生成含方案的历史会话（plan_sessions 落库 + .pi/sessions 生成对话 + job 记录），前端打开即以该会话为最新可续聊优化【代码路径已打通，待开发者在真实环境确认】
- [x] 失败隔离实现项端到端已由单测/静态审查确认【含真实 LLM 与合规待处理的手动触发 e2e 待开发者在真实环境验证】