# Checklist

## backend 层
- [x] `helpers.mjs` 提供 `corsHeaders`/`json`/`readBody`，`auth.mjs` 复用同一 `json`
- [x] 共享 gateway 转发函数存在，`/api/insights/extract` 与 `/api/knowledge/suggest` 复用且错误映射不变
- [x] `store.mjs` 新增 `addCustomer`/`removeCustomer`，外部不再直接 `seed.customers.push/splice`
- [x] `getReminders` 延迟 `import("./strategies.mjs")` 改为静态 import
- [x] server.mjs 拆为 `routes/*` 领域模块，`register(ctx)` 组装，server.mjs 仅鉴权 + 组装
- [x] 所有原 HTTP 路径响应与拆分前一致（状态码/响应体/CORS）
- [x] `node --test` 全绿（compliance/knowledge）
- [x] backend 冒烟通过（health/登录/客户/快照/方案/批量/洞察/提醒区）

## pi-gateway 层
- [x] `server.ts` 路由分发与 handler 分离，6 个 handler 复用 `readJsonBody` 样板辅助
- [x] 共享一次性 LLM JSON 调用原子存在，`createInsightLlm` 与 `runLlmJson` 复用
- [x] `insight-orchestrator.ts` 按职责拆文件（prompts / 编排 / backend 读写收敛到 backend-client）
- [x] 对外导出 `runBatchInsight`/`createInsightDeps`/`runExtractInsightFromPlan`/`runSuggestKnowledge` 签名兼容
- [x] `tsc`（npm run build）通过
- [x] `vitest run` 全绿（orchestrator/retry-context）
- [x] pi-gateway 冒烟通过（批量洞察/workflow/run/extract/suggest）

## web 层
- [x] `main.ts` 横切拆分（渲染辅助 `render-utils.ts`），`FinanceAdvisorApp` 单类与状态保留
- [x] （数据加载器与事件分发因深度耦合 `this` 状态，评审后有意保留类内，不属违规）
- [x] DOM 结构、事件委托、渲染结果与拆分前一致
- [x] `vite build` 通过
- [ ] 前端冒烟通过（登录/工作台/方案/会话/管理后台）——留待开发者浏览器验证

## 全局约束
- [x] 未引入任何新第三方依赖
- [x] 未改动任何对外 HTTP 契约 / 数据文件格式 / 业务输出