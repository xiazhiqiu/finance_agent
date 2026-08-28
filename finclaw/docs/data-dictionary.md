# 数据字段字典(Data Dictionary)

> 依据当前代码实现整理,覆盖业务主数据、运行时数据、方案与合规、Workflow 引擎、
> 认证会话、网关协议、配置与前端请求类型。可与 `api-reference.md` 对照阅读。

---

## 目录

1. [业务主数据(seed.json)](#1-业务主数据)
2. [运行时数据文件(.runtime/data/)](#2-运行时数据文件)
3. [方案与合规数据](#3-方案与合规数据)
4. [Workflow 引擎数据(pi-gateway)](#4-workflow-引擎数据)
5. [认证与会话数据](#5-认证与会话数据)
6. [网关 SSE 协议](#6-网关-sse-协议)
7. [配置与环境变量](#7-配置与环境变量)
8. [前端请求/响应类型(web)](#8-前端请求响应类型)
9. [客户经理个人知识](#9-客户经理个人知识)

---

## 1. 业务主数据

来源:`backend/data/seed.json`(启动时整体读入内存,见 `store.mjs` 的 `loadSeed`)。

### 1.1 CustomerProfile(客户画像)

> 完整客户详情,`GET /api/customers/:id/profile` 与 `GET /api/customers` 返回该结构。
> 定义:`web/src/types.ts`、`pi-gateway/src/workflow/types.ts`

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| customerId | string | 是 | 客户唯一标识,格式 `CUST_xxx` |
| name | string | 是 | 客户姓名 |
| segment | string | 否 | 客户分层:`私行客户` / `财富客户` / `成长客户` |
| occupation | string | 否 | 职业 |
| riskTolerance | string | 是* | 风险承受等级 `C1`~`C5`;**空串表示未评估**(workflow 前置闸门会拦截) |
| aum | number | 是 | 管理资产总额(元) |
| aumStructure | Record\<string, number\> | 否 | 资产结构分布,键为资产类别(如 `活期`/`定期存款`/`理财`/`基金`),值为金额 |
| upcomingMaturities | Array\<Maturity\> | 否 | 即将到期资产,`Maturity = { amount: number, dueDate: string(YYYY-MM-DD), productType: string }` |
| recentTransactions | string | 否 | 近期交易/资金动态描述(自由文本,供 LLM 参考) |
| lastContact | LastContact | 否 | 最近联系记录,`LastContact = { channel: string, date: string(YYYY-MM-DD), topic: string }`,channel 取值:电话/企业微信/面谈 |
| preferences | string[] | 否 | 客户偏好标签(如 `稳健收益`、`流动性`、`全球配置`) |
| lifeCycleStage | string | 否 | 生命周期阶段:财富积累期/家庭成熟期/财富增长期/退休期/财富传承期 |
| riskAssessmentDate | string | 否 | 风险评估日期(YYYY-MM-DD),空串同"未评估" |

> `*` riskTolerance 在类型上非可选,但 seed 数据中存在空串值(`CUST_007`/`CUST_011`)。

### 1.2 CustomerSummary(客户摘要)

> 列表场景的精简结构,`GET /api/customers` 返回。

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| customerId | string | 是 | 客户唯一标识 |
| name | string | 是 | 客户姓名 |
| segment | string | 否 | 客户分层 |
| riskTolerance | string | 否 | 风险承受等级 |
| aum | number | 否 | 管理资产总额 |

### 1.3 Product(产品)

> `GET /api/products/eligible?customerId=` 返回该客户**风控过滤后**的在售产品。
> 定义:`workflow/types.ts`

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| productId | string | 是 | 产品唯一标识,格式 `Pxxx` |
| name | string | 是 | 产品名称 |
| category | string | 是 | 产品类别:固收理财/固收+/权益基金/存款/现金管理/保险/结构存款/商品基金/另类投资 |
| riskLevel | string | 是 | 风险等级 `R1`~`R5` |
| minAmount | number | 是 | 起购金额(元) |
| availableQuota | number | 是 | 可用额度(≤0 视为无配额,合规审查会拦截) |
| onSale | boolean | 是 | 是否在售(合规审查会拦截下架品) |
| tenor | string | 是 | 期限描述,如 `90天` / `一年` / `长期` / `灵活申赎` |
| expectedReturn | string | 是 | 预期收益描述(文本),如 `2.4%-2.8%` / `浮动收益` / `净值型` |
| campaigns | string[] | 是 | 营销活动标签,如 `到期承接` / `财富季` / `全球配置` |

### 1.4 Strategy(营销策略)

> `GET /api/products/strategies` 返回全部策略。
> 定义:`workflow/types.ts`

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| id | string | 是 | 策略 ID,seed 含 `maturity`/`allocation`/`retention` |
| priority | number | 是 | 优先级,数值越大越优先(100/80/60) |
| name | string | 是 | 策略名称,如 `到期资金承接` |
| rule | string | 是 | 策略规则描述,注入 LLM 上下文 |

### 1.5 User(用户 / 客户经理)

> seed 中的初始用户,运行时以 `users.json` 为准。见 `backend/data/seed.json`。

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| managerId | string | 是 | 用户唯一标识,`MGR_ADMIN` 为超级管理员,其余 `MGR_xxx` |
| username | string | 是 | 登录用户名,唯一 |
| password | string | 是 | bcrypt 加密后的密码哈希 |
| name | string | 是 | 显示姓名 |
| role | string | 是 | 角色:`admin` / `manager`(RBAC) |
| avatar | string | 是 | 头像 URL(当前均为空) |

### 1.6 customer_assignments(客户分配)

> seed 内嵌的初始分配表,运行时以 `customer_assignments.json` 为准。

| 字段 | 类型 | 说明 |
|------|------|------|
| [customerId] | string \| null | 反向映射 `{ customerId: managerId }`;`null` 表示未分配 |

---

## 2. 运行时数据文件

目录:`${FINANCE_RUNTIME_DIR || finclaw/.runtime/data}/`(见 `store.mjs`),均为 JSON 文件,不存在时读取 seed 兜底。

| 文件 | 结构 | 说明 |
|------|------|------|
| knowledge.json | `{ [managerId]: string }` | 每位客户经理的知识库 Markdown 原文(见 `store.mjs`) |
| customer_tasks.json | `{ tasks: { [customerId]: Task[] } }` | 客户任务快照(`store.mjs`),`Task = { taskId, customerId, strategyType, strategyName, category, status('pending'\|'done'\|'skipped'), source('rule'\|'llm'\|'manual'), priority, triggerCondition, createdAt }`。写入:`scheduler` 批量洞察规则层按 **Y1 合并**(`mergeTasksForCustomer`:非 pending 保留、pending 由本轮命中覆盖、失效策略待办自动移除) |
| snapshots.json | Array\<Snapshot\> | 方案快照历史(见 `store.mjs`),`Snapshot = { id: string(uuid), createdAt: string(ISO8601), updatedAt: string(ISO8601), planId: string, customerId: string, managerId?: string, title, score, tags, diagnosis, allocation, products, scripts, markdown, generation?: "initial"\|"optimize", instruction?: string\|null, adopted: boolean }` |
| plan_sessions.json | `{ sessions: PlanSession[] }` | 方案会话持久化(见 `store.mjs`),`PlanSession = { sessionId, customerId, managerId, sessionKey, title, createdAt, updatedAt, plans, selectedPlanId, adoptedPlanId, lastInstruction, complianceReport }` |
| users.json | `{ [managerId]: User }` | 运行时用户覆盖,缺省回退 seed.users(见 `store.mjs`) |
| sessions.json | `{ [token]: Session }` | 登录会话表(见 `store.mjs`) |
| customer_assignments.json | `{ [customerId]: managerId \| null }` | 分配关系运行时覆盖,自动合并 seed(见 `store.mjs`) |
| customer_summaries.json | `{ summaries: { [customerId]: { customerId, preferences: string[], adoptedPlans: string[], concerns: string[], opportunities: string[], raw: string, updatedAt: string } } }` | 客户级会话摘要(见 `store.mjs`);由 pi-gateway 在主对话结束后节流刷新(默认 10 分钟),用于新会话稳定前缀注入与跨会话记忆;读写接口 `GET/PUT /api/customers/:id/summary` |
| market_brief.json | `{ content: string, updatedAt: string }` | 市场简报(见 `store.mjs`);由客户经理经 `PUT /api/market/brief` 维护,方案生成(plan scope)与 market_query 工具消费 |

> 快照创建逻辑(`routes/plans.routes.mjs` + `store.mjs saveSnapshot`):`POST /api/plans/snapshots` 接收扁平字段
> `{ planId, customerId, managerId?, title, score, tags, diagnosis, allocation, products, scripts, markdown, generation?, instruction?, adopted }`,
> **按 `planId` 幂等**——同一 planId 已落盘时覆盖旧快照字段,保留原 `id`/`createdAt` 并刷新 `updatedAt`;新增记录时服务端补 `id`(uuid)与 `createdAt`(ISO)。

---

## 3. 方案与合规数据

### 3.1 MarketingPlan(营销方案)

> LLM 输出与前端渲染的核心结构。定义:`web/src/types.ts`、`workflow/types.ts`
> 必填字段在 `llm-leaf.ts` 的 `validatePlan` 中强制校验,缺任一字段直接抛错。

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| planId | string | 是 | 方案唯一标识(LLM 生成,optimize 时必须与 target_plan_id 一致) |
| customerId | string | 是 | 所属客户 ID |
| title | string | 是 | 方案标题;同时是违禁词定位与"缺风险提示"定位的 key |
| score | number | 是 | 方案评分 |
| tags | string[] | 是 | 方案标签 |
| diagnosis | string | 是 | 客户诊断结论(文本) |
| allocation | Record\<string, Allocation\> | 是 | 配置建议,`Allocation = { pct: number(占比%), products: string[](产品ID) }` |
| products | Array\<PlanProduct\> | 是 | 推荐产品明细,`PlanProduct = { productId, name, category, riskLevel, reason }`(reason 为推荐理由) |
| scripts | Scripts | 是 | 触达话术,`Scripts = { wecom: string(企业微信话术), phone: string[](电话话术多条) }` |
| markdown | string | 是 | 完整方案 Markdown(前端渲染主体;**必须包含风险揭示语**,逐字匹配) |

### 3.2 ComplianceReport(合规审查报告)

> `auditPlans(customer, products, plans)` 输出(`backend/src/compliance.mjs`),
> 经 `POST /api/plans/audit` 返回。定义:`web/src/types.ts`、`workflow/types.ts`

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| passed | boolean | 是 | 是否全部通过(四项均无问题才为 true) |
| riskMismatch | boolean | 是 | 是否存在风险错配(冗余,可由 mismatchedProducts 推导) |
| mismatchedProducts | Array\<Issue\> | 是 | 风险等级高于客户承受等级的产品,`Issue = { productId, name, reason }` |
| offSaleProducts | Array\<Issue\> | 是 | 产品状态问题,reason ∈ `产品不存在`/`产品已下架`/`产品配额不足` |
| forbiddenWords | Array\<WordIssue\> | 是 | 违禁词命中,`WordIssue = { word, context(命中方案的 title), suggestion }` |
| missingRiskDisclosures | string[] | 是 | 缺风险揭示的方案,格式 `"${plan.title} 缺少必要风险提示"` |
| summary | string | 是 | 审查结论摘要(`"全部方案通过合规审查"` 或 `"存在风险错配、产品状态或话术合规问题"`) |
| markdown | string | 是 | Markdown 格式审查报告(`## 合规审查\n\n${summary}`) |

> 违禁词黑名单(`compliance.mjs`):`保本保收益`、`稳赚不赔`、`刚性兑付`、`零风险`、`绝对收益`。
> 必备风险揭示语(`compliance.mjs`):`理财有风险，投资需谨慎`、`基金过往业绩不预示未来表现`(逐字包含即通过)。

---

## 4. Workflow 引擎数据

位置:`pi-gateway/src/workflow/types.ts`。编排逻辑见 `orchestrator.ts`。

### 4.1 WorkflowContext(工作流上下文)

> `backend-client.ts` 的 `fetchContext(customerId, managerId, scope)` 组装:
> scope=`"plan"`(默认)并发拉取画像 + 适配产品 + 知识库 + 市场简报(`/api/customers/:id/profile` + `/api/products/eligible` + `/api/knowledge` + `/api/market/brief`,market brief 拉取失败降级为空串);
> scope=`"customer"` 仅拉取客户画像(洞察/自进化/摘要链路使用,不消费产品与市场数据)。

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| customer | CustomerProfile | 是 | 客户画像 |
| products | Product[] | 是 | 风控过滤后该客户可售产品 |
| strategies | Strategy[] | 否 | 方案引擎不消费策略文本,fetchContext 不再拉取;保留字段仅为兼容旧数据 |
| personalKnowledge | string | 是 | 客户经理个人知识 Markdown(`/api/knowledge` 响应的 `content` 字段) |
| marketBrief | string | 否 | 市场简报文本(`/api/market/brief` 响应的 `content` 字段,拉取失败为空串) |

### 4.2 WorkflowRequest / WorkflowAction

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| action | `"generate_plans" \| "optimize_plan"` | 是 | 工作流动作;网关据此分流到 `runGeneratePlan` / `runOptimizePlan` |
| payload.customer_id | string | 是 | 目标客户 ID |
| payload.manager_id | string | 是 | 发起客户经理 ID |
| payload.instruction | string | 否 | 优化指令,**optimize_plan 必填**,generate 忽略 |
| payload.target_plan_id | string | 否 | 目标方案 ID,**optimize_plan 必填** |
| payload.previous_plans | MarketingPlan[] | 否 | 上轮方案,**optimize_plan 必须恰好 1 套且 planId 与 target_plan_id 匹配** |

### 4.3 WorkflowResult(工作流输出)

> 网关将结果 `JSON.stringify` 后放入 SSE `final` 事件。

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| plans | MarketingPlan[] | 是 | 生成的方案;失败时为 `[]` |
| attempt | number | 否 | 成功时的轮次(1~maxAttempts) |
| error | string | 否 | 失败原因:风险未评估 / 参数缺失 / 3 轮耗尽(`"合规审查未通过，已重试3次"`) |
| complianceReport | ComplianceReport | 否 | 通过时携带;耗尽时携带最后一轮报告 |

### 4.4 Retry 修正指令(`retry-context.ts`)

| 类型 | 字段 | 说明 |
|------|------|------|
| RetryIssueType | — | `"mismatchedProduct" \| "offSaleProduct" \| "forbiddenWord" \| "missingRiskDisclosure"` |
| RetryIssue | type: RetryIssueType | issue 类型 |
| | productId?: string | 涉及产品 ID(违禁词/缺提示两类为空) |
| | productName?: string | 涉及产品名称 |
| | detail: string | 问题详情(引用合规报告 reason) |
| | fixSuggestion: string | 修正建议(文案见 `retry-context.ts`) |
| RetryInstruction | planId: string | 定位到具体方案 |
| | title: string | 方案标题 |
| | issues: RetryIssue[] | 该方案的修正项集合 |

### 4.5 GenerateParams(LLM 叶子入参)

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| context | WorkflowContext | 是 | 业务上下文(JSON 注入 prompt) |
| mode | `"generate" \| "optimize"` | 是 | generate 返回 3 套差异方案;optimize 必须且只能返回 1 套 |
| retryInstructions | RetryInstruction[] | 否 | 第 2 轮起注入,作为修正依据 |
| previousPlan | MarketingPlan | 否 | optimize 时注入目标方案 |
| instruction | string | 否 | optimize 时注入优化指令 |

### 4.6 依赖注入接口(供单测 mock)

| 接口 | 方法签名 | 说明 |
|------|----------|------|
| BackendClient | `fetchContext(customerId, managerId, scope?): Promise<WorkflowContext>` | 取数,scope 说明见 4.1(默认 `"plan"` 并发拉取,不再拉取 strategies) |
| | `audit(customerId, plans, managerId): Promise<ComplianceReport>` | 调 `POST /api/plans/audit` |
| LlmLeaf | `generatePlans(params): Promise<MarketingPlan[]>` | LLM 生成(无工具、独立人设、临时会话) |
| RetryBuilder | `buildRetryInstructions(plans, report): RetryInstruction[]` | report.passed 时返回 `[]` |
| WorkflowDeps | backend / llm / retry / maxAttempts? | `maxAttempts` 默认 **3**(见 `orchestrator.ts`) |

---

## 5. 认证与会话数据

### 5.1 Session(登录会话)

> `auth.mjs` 创建,`SESSION_MAX_AGE = 86400s(24h)`。以 `session` Cookie(HttpOnly, SameSite=Strict)下发。

| 字段 | 类型 | 说明 |
|------|------|------|
| token | string | 会话 token(uuid,同时作为 sessions.json 的 key) |
| managerId | string | 用户 ID |
| role | string | 角色,缺省 `"manager"` |
| createdAt | string | 创建时间(ISO8601) |
| expiresAt | string | 过期时间(ISO8601),`createdAt + 24h` |

### 5.2 登录 / getMe 响应(UserInfo)

> `auth.mjs`(login / getMe)。定义:`web/src/types.ts`

| 字段 | 类型 | 说明 |
|------|------|------|
| managerId | string | 用户唯一标识 |
| name | string | 显示姓名 |
| role | `"admin" \| "manager"` | 角色 |
| avatar | string | 头像 URL(当前为空) |

### 5.3 ManagerInfo(管理员列表项)

> `GET /api/admin/managers` 返回(`routes/admin.routes.mjs`)。定义:`web/src/types.ts`

| 字段 | 类型 | 说明 |
|------|------|------|
| managerId | string | 用户 ID |
| username | string | 登录用户名 |
| name | string | 姓名 |
| customerCount | number | 名下客户数(`getCustomerCount`) |

### 5.4 AdminCustomer(管理员视角客户)

> `GET /api/admin/customers` 返回(`routes/admin.routes.mjs`)。定义:`web/src/types.ts`
> = CustomerProfile + 以下两字段:

| 字段 | 类型 | 说明 |
|------|------|------|
| assignedManagerId | string \| null | 当前分配的管理员 ID,null = 未分配 |
| assignedManagerName | string \| null | 当前分配的管理员姓名 |

---

## 6. 网关 SSE 协议

> 入口:`POST /api/agent/run`,请求体 `{ sessionKey: string, message: string }`(message 为**纯文本**自由对话;
> 业务上下文(客户画像白名单字段/客户摘要/知识库截断)在**会话创建时经系统提示稳定前缀注入**
> (`agent-session.ts` 经 `appendSystemPromptOverride` 追加 `context-builder.ts` 的 `buildChatStablePrefix` 产物),
> 用户消息原样发送不再拼接 `[会话上下文]` 前缀;历史会话中旧格式前缀仍经 `stripContextPrefix` 剥离展示;
> 已移除旧 `{action, payload}` JSON 协议)。

响应为 SSE 流,事件类型(`pi-gateway/src/server.ts` + `agent-session.ts` + `handlers.ts`):

| 事件 | data 结构 | 说明 |
|------|-----------|------|
| thinking | `{ status: string }` | 模型开始思考 / workflow 启动 |
| tool_call | `{ toolName: string }` | 工具调用开始(仅 toolName,不携带参数/细节) |
| tool_result | `{ toolName: string, result: unknown }` | 工具执行结束;方案类工具经 `details.result` 透传完整方案数据 |
| message | `{ delta: string }` | 流式文本增量;仅透传 `text_delta`,过滤 `thinking_delta`/`toolcall_delta` |
| final | `{ text: string }` | 最终结果;workflow 路径为 `JSON.stringify(WorkflowResult)` |
| error | `{ message: string }` | 执行错误 |

> 前端解析:`advisor-gateway.ts` 的 `createSSEParser`;文本抽取 `result-parser.ts` 的 `extractMessageText`(兼容 `string` / `{text}` / `{content}` / 多段 content)。

---

## 7. 配置与环境变量

### 7.1 config.json(finclaw/config.json)

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| ports.backend | number | 3001 | 业务后端端口 |
| ports.gateway | number | 18789 | pi-gateway SSE 服务端口 |
| ports.web | number | 4174 | 前端静态服务端口(网关 CORS 白名单) |
| gateway.authToken | string | finance-local-token | 网关鉴权令牌(当前未强制校验) |
| agent.id | string | wealth-advisor | Agent ID |
| agent.managerId | string | manager-local | 默认客户经理 ID |

### 7.2 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| FINANCE_BACKEND_PORT | 3001 | 后端监听端口 |
| FINANCE_RUNTIME_DIR | finclaw/.runtime/data | 运行时数据目录 |
| FINANCE_API_URL | http://127.0.0.1:3001 | 后端地址(backend-client / agent-session 注入 bash) |
| FINANCE_INTERNAL_TOKEN | (空) | 内部服务令牌;与 `x-internal-token` 头匹配时免 session 鉴权,需 `x-manager-id` 头(`server.mjs`) |
| FINANCE_AGENT_ID | wealth-advisor | 主对话 Agent ID;会话 `sessionKey` 与 `createPlanSession` 中读取,如 `agent:wealth-advisor:finance:direct:{managerId}-{customerId}-{sessionId}` |
| FINANCE_DEFAULT_MANAGER | MGR_001 | 默认客户经理 ID;context 缺省时自定义工具取客户经理用(`customer-analyze.ts`/`plan-tools.ts`) |
| FINANCE_SUMMARY_REFRESH_MS | 600000 | 客户摘要刷新节流间隔(毫秒,默认 10 分钟);设于 pi-gateway 进程,主对话结束后按此间隔节流刷新 `customer_summaries.json` |
| PI_GATEWAY_PORT | 18789 | 网关监听端口 |
| PI_CODING_AGENT_DIR | finclaw/.pi | pi agent 根目录(读 auth.json / models.json) |
| FINANCE_AGENT_SANDBOX | "1"（启用） | Agent 运行沙箱开关;缺省/置 "1" 启用时用 `noTools:"builtin"` 禁用内置文件系统工具(read/ls/grep/find/edit/write),仅保留自定义后端 HTTP 业务工具,阻止 agent 读取本地开发源码;置 "0" 关闭,回退为仅剔除 bash 的可读本地文件模式(`agent-session.ts`) |

---

## 8. 前端请求/响应类型

> 定义:`web/src/types.ts`,请求体经 `FinanceApi.request` 发送,响应兼容 `T` 或 `{ data: T }` 两种形态。

| 类型 | 字段 | 说明 |
|------|------|------|
| LoginRequest | username, password | 登录 |
| ResetPasswordRequest | oldPassword, newPassword | 改密(需登录) |
| PublicResetPasswordRequest | username, oldPassword, newPassword | 公开改密 |
| CreateManagerRequest | username, name | 新增客户经理(初始密码 `123456`) |
| EditManagerRequest | username?, name? | 编辑客户经理(至少一项) |
| CreateCustomerRequest | name | 新增客户(其余字段按空默认值初始化,`routes/admin.routes.mjs`) |
| EditCustomerNameRequest | name | 管理员改客户姓名 |
| AssignCustomerRequest | managerId: string \| null | 分配/解绑(null = 解绑) |
| EditCustomerProfileRequest | 见下表 | 客户经理编辑客户画像(全可选) |
| PlanSession | sessionId, customerId, managerId, title, createdAt, updatedAt, plans, selectedPlanId, adoptedPlanId?, lastInstruction, complianceReport, sessionKey? | 方案会话对象(与 `plan_sessions.json` 一致;`adoptedPlanId` 为已成交方案,独立于 `selectedPlanId`) |
| PlanSessionSummary | 同 PlanSession | 会话列表精简项(`GET /api/sessions?customerId=` 返回) |

### EditCustomerProfileRequest 可编辑字段

| 字段 | 类型 | 说明 |
|------|------|------|
| segment | string | 客户分层 |
| occupation | string | 职业 |
| riskTolerance | string | 风险等级 |
| aum | number | 资产总额;若同时传 aumStructure,后端校验 `aum === sum(aumStructure)`,不匹配返回 400(`routes/customers.routes.mjs`) |
| aumStructure | Record\<string, number\> | 资产结构;传此项时 aum 由后端重新计算覆盖 |
| upcomingMaturities | Maturity[] | 到期资产 |
| recentTransactions | string | 近期交易 |
| lastContact | LastContact | 最近联系 |
| preferences | string[] | 偏好 |
| lifeCycleStage | string | 生命周期 |
| riskAssessmentDate | string | 风险评估日期 |

---

## 9. 客户经理个人知识

> `GET /api/knowledge` 返回 `{ ...parsedFields, content }`(`routes/knowledge.routes.mjs`);
> `POST /api/knowledge/save` 接收 `content`(Markdown)或各字段,服务端 `composeKnowledgeMarkdown` 重组后存 `knowledge.json`。
> Markdown 约定三节标题:`### 话术模板` / `### 产品优先度` / `### 风格偏好`(`knowledge.mjs`)。

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| talkTemplates | string | 是 | 话术模板 |
| productPriority | string | 是 | 产品优先度 |
| stylePreference | string | 是 | 风格偏好 |
| content | string | 否(仅 GET 响应) | 完整 Markdown 原文 |

---

## 附:A股/港股场景说明

本系统字段命名遵循内部约定(非证券行情数据):`aum`/`riskTolerance(C1-C5)`/`riskLevel(R1-R5)` 为银行财富管理口径;
文档中"产品风险等级高于客户承受等级"即合规错配判定。与 `westock` 等行情数据源无字段关联。
