# 功能模块解耦结构优化 Spec

## Why

系统三层存在明显的模块耦合热点，影响可维护性与可测试性：
- `backend/server.mjs`（约 620 行）单个 `createServer` 回调内联了全部路由注册、业务逻辑与数据访问，多个领域混在一起。
- `pi-gateway/src/workflow/insight-orchestrator.ts`（约 620 行）一个文件混杂类型定义、prompt 构建、生产 LLM 实现、backend 手动 fetch、核心编排与 M4 建议；且 `createInsightLlm` 与 `runLlmJson` 两处一次性 LLM 调用高度重复，backend 读写与 `backend-client.ts` 职责重叠。
- `web/src/main.ts`（约 2000 行）单类 `FinanceAdvisorApp` 同时承担渲染、事件委托、数据加载、网关交互与全部状态。

目标：**在不改任何功能行为、不引入新第三方依赖、纯手工拆分**的前提下，按领域/职责解耦，提升模块边界清晰度。验证手段为现有测试全绿 + 每层拆分后冒烟。

## What Changes

- **backend**：`server.mjs` 按领域拆成多个 `routes/*` 模块，采用 `register(ctx)` 注入式；`server.mjs` 仅保留鉴权与组装。共享 HTTP 辅助（`json`/`readBody`/`corsHeaders`）抽到 `helpers.mjs`。两处重复的 pi-gateway 转发（`/api/insights/extract` 与 `/api/knowledge/suggest`）抽为共享转发函数。
- **backend/store.mjs**：全局可变 `seed` 的外部直接 `push/splice` 收敛为函数式接口（`addCustomer`/`removeCustomer`）；`getReminders` 的延迟 `import("./strategies.mjs")` 改为顶部静态 import（strategies 为无依赖纯函数，不构成循环）。
- **pi-gateway**：`server.ts` 抽出路由分发层，6 个 handler 的重复"读 body + JSON.parse + 校验"样板抽为 `readJsonBody` 等辅助；`insight-orchestrator.ts` 按职责拆分为独立文件（编排 / prompts / 一次性 LLM 原子 / backend 读写收敛到 `backend-client.ts`）。
- **pi-gateway**：抽取共享"一次性 LLM JSON 调用"原子，`createInsightLlm` 与 M4 的 `runLlmJson` 复用之。
- **web**：`main.ts` 横切职责拆分——抽渲染辅助、数据加载器、事件分发；`FinanceAdvisorApp` 单类与约 40 个状态字段保留。

**约束**：所有对外 HTTP 契约、请求/响应体、路由路径、业务输出、数据文件格式均保持不变（**BREAKING** 无）。

## Impact

- Affected specs: 后端数据层（store）、业务路由（server）、调度（scheduler）、认证（auth）；pi-gateway 编排（insight-orchestrator / workflow）；web 前端（main）。
- Affected code:
  - `finclaw/backend/src/`（server.mjs、store.mjs、auth.mjs 及新增 helpers.mjs、routes/*）
  - `finclaw/pi-gateway/src/`（server.ts、workflow/insight-orchestrator.ts、workflow/backend-client.ts、workflow/llm-leaf.ts 及新增文件）
  - `finclaw/web/src/`（main.ts 及新增辅助模块）

## MODIFIED Requirements

### Requirement: backend 领域路由拆分
`server.mjs` SHALL 仅保留通用鉴权、CORS、内部令牌分流与 router 组装；各领域路由（auth/admin/customers/products/knowledge/plans/sessions/batch/insights/reminders）SHALL 各自独立成 `routes/*.mjs` 模块，通过 `register(ctx)` 注入共享上下文（`json`/`readBody`/`corsHeaders`/`store`/`auth`/`env`）。

#### Scenario: 请求仍按原路径分发
- **WHEN** 客户端按原路径调用任意接口
- **THEN** 响应与拆分前完全一致（状态码、响应体、CORS 头）

#### Scenario: 新增领域路由
- **WHEN** 未来新增一个领域接口
- **THEN** 只需新增一个 `routes/*.mjs` 并在 `routes/index.mjs` 注册，不改其他路由

### Requirement: backend 数据访问收敛
`store.mjs` 的 `seed` 外部直接可变操作 SHALL 收敛为函数式接口 `addCustomer(customer)` / `removeCustomer(customerId)`，内部仍操作同一 `seed.customers` 数组引用，写语义不变。

#### Scenario: 新增/删除客户
- **WHEN** 管理员新增或删除客户
- **THEN** 走 `store` 函数式接口，`seed.customers` 行为与拆分前一致（引用不变、ID 生成规则不变）

### Requirement: 消除 getReminders 延迟 import
`store.mjs` 的 `getReminders` 中 `await import("./strategies.mjs")` SHALL 改为顶部静态 `import`（strategies.mjs 为无依赖纯函数模块，不构成循环依赖）。

#### Scenario: 提醒区汇总
- **WHEN** 调用 `/api/reminders`
- **THEN** 返回的 `insightPending/batchCompleted/auditPending/awakenSuggestion` 与拆分前一致

### Requirement: 抽取共享 gateway 转发
`server.mjs` 中 `/api/insights/extract` 与 `/api/knowledge/suggest` 两处几乎相同的 fetch 转发 SHALL 抽为共享转发函数（如 `forwardGateway(path, body, managerId)`），保留原有错误映射与状态码。

#### Scenario: 方案洞察提取与知识库建议
- **WHEN** 调用 `/api/insights/extract` 或 `/api/knowledge/suggest`
- **THEN** 转发到 pi-gateway 的行为、错误处理（502/gwPayload.error）与拆分前一致

### Requirement: pi-gateway 路由层与样板辅助
`server.ts` 6 个 handler 的重复"读取 body + JSON 解析 + 参数校验 + 统一响应"样板 SHALL 抽为 `readJsonBody` 等辅助；路由分发逻辑 SHALL 从 handler 实现中分离，保持对外 SSE/JSON 契约不变。

#### Scenario: 各入口请求
- **WHEN** 调用 `/api/agent/run`、`/api/insight/batch`、`/api/workflow/run`、`/api/insight/extract`、`/api/knowledge/suggest`
- **THEN** 响应事件流 / JSON 与拆分前一致

### Requirement: insight-orchestrator 按职责拆分
`insight-orchestrator.ts` SHALL 按职责拆为独立文件：批量洞察编排、prompt 构建、一次性 LLM JSON 原子、backend 读写收敛到 `backend-client.ts`；对外导出（`runBatchInsight`/`createInsightDeps`/`runExtractInsightFromPlan`/`runSuggestKnowledge`）签名保持兼容。

#### Scenario: 批量洞察与 M4 建议
- **WHEN** 批量洞察、方案洞察提取、知识库建议任一被调用
- **THEN** 对外行为与拆分前一致

### Requirement: 共享一次性 LLM JSON 调用原子
`createInsightLlm` 与 M4 的 `runLlmJson` 中重复的"建 session → prompt → 收集 assistant 文本 → 宽松 JSON 解析 → 清理 sessionDir"逻辑 SHALL 抽为共享原子函数，两处复用。

#### Scenario: LLM JSON 输出解析
- **WHEN** 洞察生成或方案洞察提取触发 LLM 调用
- **THEN** 输出解析与 session 清理行为与拆分前一致

### Requirement: web main.ts 横切拆分
`main.ts` SHALL 将渲染辅助、数据加载器、事件分发按横切职责抽为独立模块/辅助对象；`FinanceAdvisorApp` 单类与约 40 个状态字段保留，DOM 结构、事件委托、渲染结果不变。

#### Scenario: 前端各界面
- **WHEN** 登录 / 工作台 / 方案 / 会话 / 管理后台任一交互
- **THEN** UI 渲染与前后端调用与拆分前一致