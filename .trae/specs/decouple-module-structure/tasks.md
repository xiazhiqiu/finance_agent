# Tasks

> 实施顺序：自底向上（backend → pi-gateway → web），每层拆分完成后先跑该层现有测试 + 冒烟，再进入下一层。各层内部无依赖的子任务可并行。

## 第 1 层 · backend（finclaw/backend/src）

- [x] Task 1: 抽取共享 HTTP 辅助（helpers.mjs）
  - [x] SubTask 1.1: 新建 `helpers.mjs`，从 server.mjs 迁移 `corsHeaders` / `json` / `readBody`
  - [x] SubTask 1.2: 让 `auth.mjs` 复用 `helpers.mjs` 的 `json`（消除 auth 内重复的 json），`requireAuth`/`requireAdmin` 行为不变

- [x] Task 2: 抽取共享 gateway 转发
  - [x] SubTask 2.1: 新建 `forward.mjs`，实现 `forwardGateway(path, body, managerId)`，迁移 `/api/insights/extract` 与 `/api/knowledge/suggest` 两处转发的共同逻辑
  - [x] SubTask 2.2: 保留原错误映射（502 / gwPayload.error）与状态码

- [x] Task 3: 重构 store.mjs（seed 函数式接口 + 消除延迟 import）
  - [x] SubTask 3.1: 新增 `addCustomer(customer)` / `removeCustomer(customerId)`，内部操作 `seed.customers` 数组引用，保持 ID 生成规则不变
  - [x] SubTask 3.2: `getReminders` 的 `await import("./strategies.mjs")` 改为顶部静态 `import`（strategies 为无依赖纯函数）
  - [x] SubTask 3.3: 确认既有导出（readUsers/writeUsers/…/computeProfileHash 等 43 个）签名不变

- [x] Task 4: 按领域拆 routes 模块
  - [x] SubTask 4.1: 新建 `routes/index.mjs`，聚合各领域 router 并定义 `register(ctx)` 组装
  - [x] SubTask 4.2: 新建 `routes/auth.routes.mjs`（login/logout/reset-password-public/me/reset-password）
  - [x] SubTask 4.3: 新建 `routes/admin.routes.mjs`（managers/customers 管理 + assign + 级联删除）
  - [x] SubTask 4.4: 新建 `routes/customers.routes.mjs`（列表/详情/profile/tasks）
  - [x] SubTask 4.5: 新建 `routes/products.routes.mjs`（eligible/strategies）
  - [x] SubTask 4.6: 新建 `routes/knowledge.routes.mjs`（knowledge 读写 + suggest 转发）
  - [x] SubTask 4.7: 新建 `routes/plans.routes.mjs`（audit/snapshots）
  - [x] SubTask 4.8: 新建 `routes/sessions.routes.mjs`（会话 CRUD）
  - [x] SubTask 4.9: 新建 `routes/batch.routes.mjs`（batch/insight/plans/jobs）
  - [x] SubTask 4.10: 新建 `routes/insights.routes.mjs`（insights 列表/新增/extract 转发/confirm/reject）
  - [x] SubTask 4.11: 新建 `routes/reminders.routes.mjs`（reminders）

- [x] Task 5: 简化 server.mjs（仅鉴权 + 组装）
  - [x] SubTask 5.1: server.mjs 保留 CORS/OPTIONS、health、内部令牌分流、`requireAdmin`/`requireAuth` 后调用 `routes/index.mjs` 的组装结果
  - [x] SubTask 5.2: 删除内联业务代码，只保留启动与 startScheduler

- [x] Task 6: backend 层验证
  - [x] SubTask 6.1: `node --test` 全绿（compliance/knowledge 测试）
  - [x] SubTask 6.2: 启动 backend 冒烟：health、登录、客户列表、快照、方案、批量、洞察、提醒区各入口返回与拆分前一致

## 第 2 层 · pi-gateway（finclaw/pi-gateway/src）

- [x] Task 7: server.ts 路由层 + 样板辅助
  - [x] SubTask 7.1: 抽取 `readJsonBody` 等辅助，6 个 handler 复用（读 body + parse + 校验）
  - [x] SubTask 7.2: 路由分发（agent/run、insight/batch、workflow/run、insight/extract、knowledge/suggest）从 handler 实现中分离，SSE/JSON 契约不变

- [x] Task 8: 抽取共享一次性 LLM JSON 原子
  - [x] SubTask 8.1: 新建共享原子（`llm-json.ts`），封装"建 session → prompt → 收集 assistant 文本 → parseJsonWithRepair → 清理 sessionDir"
  - [x] SubTask 8.2: `createInsightLlm` 与 M4 `runLlmJson` 复用之，删除重复实现

- [x] Task 9: insight-orchestrator.ts 按职责拆文件
  - [x] SubTask 9.1: 拆出 prompt 构建（buildInsightPrompt / buildExtractInsightPrompt / buildKnowledgeSuggestPrompt）→ `prompts.ts`
  - [x] SubTask 9.2: 拆出批量洞察编排（runBatchInsight / InsightRequest / InsightResult / InsightDeps）→ `insight-batch.ts`
  - [x] SubTask 9.3: backend 读写（backendWriteInsight / backendReadRuleTasks）收敛到 `backend-client.ts`
  - [x] SubTask 9.4: 保持对外导出 `runBatchInsight`/`createInsightDeps`/`runExtractInsightFromPlan`/`runSuggestKnowledge` 签名兼容（insight-orchestrator.ts 改为聚合 re-export）

- [x] Task 10: pi-gateway 层验证
  - [x] SubTask 10.1: `tsc`（npm run build）通过
  - [x] SubTask 10.2: `vitest run` 全绿（orchestrator/retry-context 测试，25 用例）
  - [x] SubTask 10.3: 启动冒烟：批量洞察、workflow/run、extract、suggest 入口正常（校验契约 400 一致）

## 第 3 层 · web（finclaw/web/src）

- [x] Task 11: main.ts 横切职责拆分
  - [x] SubTask 11.1: 抽渲染辅助（escapeHtml/money）到独立模块 `render-utils.ts`
  - [x] SubTask 11.2: 抽数据加载器 —— **评审后有意不拆**：loadCustomers/loadPendingInsights/loadReminders/loadAdminData 直接读写 `this` 状态并调用 `this.render()`，`this.api`（api.ts）本身已是独立数据访问层，强制抽取需注入大量 setter 与渲染回调，属过度设计且有破坏功能风险（AGENTS.md「简洁优先」）
  - [x] SubTask 11.3: 事件分发 —— **评审后有意不拆**：handleClick/handleInput/handleKeydown 深度依赖 `this` 私有 action 方法，抽取会破坏现有行为，保留类内
  - [x] SubTask 11.4: `FinanceAdvisorApp` 单类与约 40 个状态字段保留，DOM 结构与渲染结果不变

- [x] Task 12: web 层验证
  - [x] SubTask 12.1: `vite build` 通过
  - [ ] SubTask 12.2: 冒烟：登录 / 工作台 / 方案 / 会话 / 管理后台交互正常，调用契约不变（留待开发者浏览器验证）

# Task Dependencies

- [Task 1] 依赖 [ ]（backend 基础，其余 backend 任务前置）
- [Task 2] 依赖 [Task 1]（复用 helpers）
- [Task 3] 依赖 [Task 1]（复用 json/readBody 语义）
- [Task 4] 依赖 [Task 1] + [Task 2] + [Task 3]（路由依赖 helpers/store/转发）
- [Task 5] 依赖 [Task 4]
- [Task 6] 依赖 [Task 1]-[Task 5]
- [Task 7] 依赖 [ ]（pi-gateway 基础）
- [Task 8] 依赖 [ ]（LLM 原子，可独立）
- [Task 9] 依赖 [Task 8]（复用共享原子）
- [Task 10] 依赖 [Task 7] + [Task 8] + [Task 9]
- [Task 11] 依赖 [ ]（web 基础）
- [Task 12] 依赖 [Task 11]
- 层间：第 2 层依赖第 1 层全绿；第 3 层依赖第 2 层全绿

# Suggested Commit Granularity

本任务完成后暂不提交（沿用项目惯例：测试验收后再决定是否提交）。若提交，按 backend → pi-gateway → web 分 3 次提交，每层独立提交。