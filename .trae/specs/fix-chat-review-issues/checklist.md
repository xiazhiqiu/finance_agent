# Checklist

- [x] 死代码清理：`showSessionSwitcher` 字段与 `toggle-session-switcher` handler 已移除，styles.css 遗留组件样式已删除
- [x] 共享模块：`loadConfig`/`backendGet`/`findPlanFromBackend` 抽为 `tools/backend-http.ts`，`customer-analyze.ts`/`plan-tools.ts` 统一引用
- [x] safeKey 归一化为共享函数，`agent-session.ts` 与 `main.ts` 统一使用
- [x] 工具 context 字段对齐 spec（customer_profile/eligible_products/personal_knowledge/market_brief/previous_plans，无 strategies）
- [x] `WorkflowContext` 新增 `marketBrief`，`fetchContext` 返回、LLM prompt 注入市场简报
- [x] 前端发送捎带 `customer_id`/`manager_id`，后端每轮拼接会话上下文，Agent 能正确调用 `generate_plan(customer_id=...)`
- [x] 优化非默认经理不再 403：`findPlanFromBackend` 携带 internal token，backend 列表鉴权对 internal token 跳过
- [x] 历史会话卡片：标题为首条用户指令，预览为最后一条消息
- [x] sessionKey agentId 从 `FINANCE_AGENT_ID` 环境变量读取，缺省 `wealth-advisor`
- [x] `handleAgentRun` 的 workflow JSON 分流已移除，`handleWorkflowSync` 保留供 scheduler
- [x] `handlers.ts` 文件尾换行已补
- [x] `main.ts` 重复会话装载块抽取为 `applySession()`
- [x] 全量验证通过（`node --test` / `vitest run` / `tsc` / `vite build`）