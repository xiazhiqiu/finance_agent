# 智能财富顾问（基于 piagent）

面向客户经理的智能财富方案生成与优化 Web 应用。系统根据客户画像、产品信息和个人知识库生成多套财富方案，交付前自动执行合规审查（未通过时结构化重试），支持方案对比、定向优化与导出。

**底层架构**：基于 [piagent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)（pi-coding-agent SDK）构建，通过 pi-gateway 提供 HTTP POST + SSE 流式响应服务。方案生成与优化在主对话 Agent 会话内通过 `generate_plan` / `optimize_plan` 工具触发，工具内部调用纯 TS workflow 编排引擎（取数→前置风控→LLM 叶子→合规审查→有界重试）。LLM 作为无工具叶子节点仅负责生成方案 JSON，确定性逻辑全部由 TS 代码掌控。

## 架构总览

```
┌──────────┐   SSE    ┌──────────────┐   SDK    ┌──────────────┐
│  Web     │←────────→│  pi-gateway  │←────────→│ pi-coding-   │
│  (4174)  │  POST    │  (18789)     │          │ agent Agent  │
└──────────┘          └──────┬───────┘          └──────┬───────┘
                             │                         │ HTTPS
                             │ HTTP                    ▼
                      ┌──────┴───────┐          ┌──────────────┐
                      │  Backend     │          │  DeepSeek    │
                      │  (3001)      │          │  LLM API     │
                      └──────────────┘          └──────────────┘
```

**核心架构（主对话 Agent 为单一编排中枢）**：
- **主对话 Agent**（`AgentSessionManager`）—— 系统唯一编排核心。客户经理自由聊天时，Agent 在 ReAct 循环中按需调用工具：数据类 `customer_analyze` / `product_query` / `market_query` / `get_plan`，方案类 `generate_plan` / `optimize_plan`，沉淀类 `save_knowledge`
- **TS workflow 引擎**（`pi-gateway/src/workflow/`）—— 已被**降级为 `generate_plan` / `optimize_plan` 工具的内部实现**，不再作为与主对话并行的独立通道；其编排（orchestrator 取数→风控→叶子→审查→重试）由工具在 Agent 会话内调用。另保留非流式 `POST /api/workflow/run` 供 backend scheduler 定时批量生成

**三个独立进程**：
- **backend (3001)** — 业务接口与数据存储（Node.js + 原生 http）
- **pi-gateway (18789)** — Agent 服务网关（tsx + pi-coding-agent SDK，SSE 流式响应 + workflow 编排引擎）
- **web (4174)** — 前端界面（Vite + 原生 TS）

## 主要功能

- 用户登录认证与 RBAC 权限模型（管理员 / 客户经理两种角色）
- 管理员后台：增减客户经理、增减客户、配置客户-经理映射关系
- 客户经理工作台：客户列表与客户画像管理，左侧客户栏支持收起
- **客户洞察**：多选客户一键洞察 / 早 9 点定时全量洞察（规则层任务 + LLM 待确认洞察，两层解耦）；提醒区动态策略标签（12 策略 pending 命中统计，按优先级排序，点击筛选客户）；确认洞察后刷新该客户近期任务（Y1 策略合并，保留已处理状态）；前端 60s 轮询洞察结果自动上屏
- 根据客户需求生成 3 套财富方案（基于 DeepSeek LLM 叶子节点）
- 方案交付前自动执行合规审查：风险等级匹配、产品在售状态、违禁词、风险揭示语校验
- 合规未通过时结构化重试：自动生成逐条修正指令并重新生成方案（最多 3 次审查，含初审）
- 多方案对比，并选择目标方案继续优化
- 在右侧输入优化要求时，仅优化当前选中的方案，并只返回该方案
- 个人知识库分别维护"话术模板""产品优先度""风格偏好"
- 方案快照自动存档（`snapshots.json`，按 planId 幂等去重），支持方案对比与定向优化
- 推荐方案界面"当前关注大卡片 + 历史方案折叠"布局：生成 3 套方案 → 选定后未选方案收敛，迭代优化结果被采纳后同步收敛历史、突出当前方案
- 已采纳方案可「标记成交」（`adoptedPlanId`，独立于方案选择；洞察触发逻辑置空待开发）
- 会话标题默认命名「客户名 - 营销会话 - YYYYMMDD」，会话卡（含当前会话）支持行内重命名与删除，同名标题自动追加序号去重
- 会话持久化（JSONL + `plan_sessions.json`），支持主对话历史回溯与多会话管理
- 对话界面打开/刷新/切换历史会话时自动定位到最新对话（贴底），向上滚动可查看历史
- 对话界面保存全部方案历史，但模型上下文仅注入轻量摘要（planId/标题/评分），完整方案经 `details.result` 透传前端，模型可按需调用 `get_plan(plan_id)` 取用
- 切换客户 / 后台异步刷新会话时，仅局部更新中栏、右栏与客户列表高亮，**客户列表滚动位置不重置**
- 批量客户洞察 / 批量方案生成：任务运行期间对应按钮转圈并置灰（防重复提交），任务完成后只重绘左侧客户列表（含新方案红点），不打断右侧正在进行的对话与优化
- 工程健壮性：LLM JSON 输出解析失败时宽松兜底（返回 `undefined` 交由调用方容错，不抛原生错误）；LLM 叶子节点输出解析/结构校验失败时自动带错误反馈重试（最多 2 次调用，反馈不含原始输出）；JSON 缺逗号/尾随逗号启发式修复；网关接口错误统一脱敏为「服务内部异常」（原始错误仅写日志）；批量方案生成记录每客户/每批耗时日志

## 环境要求

- Windows 10/11
- Node.js 22 或更高版本
- Corepack / pnpm
- Git for Windows（提供 bash.exe，pi-coding-agent 的 bash 工具需要）
- DeepSeek API Key（或其他 pi-ai 支持的 LLM provider）

## 快速开始

### 1. 获取代码

```powershell
git clone https://gitee.com/xia-zhi-qiu/finance_agent.git
cd finance_agent
```

### 2. 配置项目

复制示例配置：

```powershell
Copy-Item finclaw\config.example.json finclaw\config.json
```

`finclaw/config.json` 仅包含端口、网关令牌、Agent ID 等非敏感配置，**不再包含 LLM 配置**：

```json
{
  "ports": { "backend": 3001, "gateway": 18789, "web": 4174 },
  "gateway": { "authToken": "finance-local-token" },
  "agent": { "id": "wealth-advisor", "managerId": "manager-local" }
}
```

### 3. 配置 LLM（DeepSeek）

在 `finclaw/.pi/auth.json` 中填写 DeepSeek API Key：

```json
{
  "deepseek": {
    "type": "api_key",
    "key": "sk-your-deepseek-api-key"
  }
}
```

默认模型在 `finclaw/.pi/settings.json` 中配置为 `deepseek-v4-flash`。如需切换模型，编辑该文件：

```json
{
  "defaultProvider": "deepseek",
  "defaultModel": "deepseek-v4-flash"
}
```

> **注意**：pi-coding-agent 的 bash 工具依赖 Git Bash，SDK 会自动探测标准安装位置的 `bash.exe`。若 Git 安装在非标准路径导致 bash 调用失败，可在该文件中显式添加 `"shellPath": "<Git安装路径>\\bin\\bash.exe"`。

### 4. 一键启动

```powershell
finclaw\start.cmd
```

启动完成后访问：

```text
http://127.0.0.1:4174
```

首次启动可能需要安装依赖（backend、pi-gateway、web 三套依赖），耗时会稍长。

## 用户认证与权限

系统内置 RBAC 权限模型，包含两种角色：

| 角色 | 说明 | 权限范围 |
|------|------|---------|
| 管理员（admin） | 系统管理者 | 管理后台：增减客户经理、增减客户、分配客户-经理映射 |
| 客户经理（manager） | 业务操作者 | 客户工作台：查看名下客户、编辑画像、生成方案、知识库管理 |

权限隔离规则：
- 管理员无法访问客户经理的功能（方案生成、知识库等），调用客户经理 API 返回 403
- 客户经理无法访问管理员后台，调用管理员 API 返回 403
- 客户经理只能看到分配给自己的客户

### 预置演示账号

| 角色 | 用户名 | 密码 | 说明 |
|------|--------|------|------|
| 管理员 | `admin` | `123456` | 超级管理员，不可删除 |
| 客户经理 | `zhangsan` | `123456` | 名下客户：张明远、李文静 |
| 客户经理 | `lisi` | `123456` | 名下客户：王启航 |

### 密码管理

- 管理员新增客户经理时，初始密码统一为 `123456`
- 客户经理登录后可在设置中修改密码
- 忘记密码可通过 `/api/auth/reset-password-public` 接口重置（需提供用户名和旧密码）

## 使用流程

**管理员**：登录后自动进入管理后台，可管理客户经理和客户分配。

**客户经理**：
1. 登录后进入客户工作台，在左侧选择客户
2. 查看并补充客户画像和需求（新客户需先编辑画像，否则无法生成方案）
3. 在个人知识库中维护话术模板、产品优先度和风格偏好
4. 生成财富方案并进行对比
5. 选择一套方案，在右侧底部输入优化要求
6. 保存或导出最终方案

## 服务管理

停止全部服务：

```powershell
finclaw\stop.cmd
```

查看运行状态：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File finclaw\scripts\status.ps1
```

如果启动脚本受 PowerShell 执行策略限制，可直接运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File finclaw\scripts\start.ps1
```

运行日志和本地数据位于：

- `finclaw/.runtime/logs` — backend.log、gateway.log、web.log
- `finclaw/.runtime/data` — 用户、客户、方案快照等业务数据
- `finclaw/.pi/sessions` — Agent 会话持久化（JSONL）

## 项目目录

```text
finance_agent/
├─ finclaw/                     智能财富顾问业务代码
│  ├─ .pi/                      pi-coding-agent 配置与能力目录
│  │  ├─ AGENTS.md              主对话 Agent 系统 Prompt（自由咨询）
│  │  ├─ settings.json          默认 provider/model
│  │  ├─ auth.json              DeepSeek API Key（请勿提交）
│  │  ├─ models.json            模型参数覆盖
│  │  ├─ agents/
│  │  │  └─ plan-generator/
│  │  │     └─ AGENTS.md        LLM 叶子节点系统 Prompt（含 MarketingPlan 模板与合规约束）
│  │  └─ sessions/              JSONL 会话存储（运行时创建）
│  ├─ pi-gateway/               Agent 服务网关（SSE + workflow 编排引擎）
│  │  ├─ src/
│  │  │  ├─ server.ts           SSE HTTP 服务入口（createServer + 路由分发 + 启动）
│  │  │  ├─ handlers.ts         handler 实现层（agent/run、insight/batch、workflow/run、insight/extract、knowledge/suggest、knowledge/candidates、case-store/search、sessions 列表/消息/compact）
│  │  │  ├─ agent-session.ts    主对话 AgentSession 封装（自定义工具注册 + 事件流 + 稳定前缀注入 + 客户摘要节流刷新）
│  │  │  ├─ session-aggregate.ts 历史会话"一问一答"聚合纯函数
│  │  │  ├─ tools/
│  │  │  │  ├─ customer-analyze.ts 自定义工具集合 createCustomTools（customer_analyze/product_query/market_query/get_plan/…）
│  │  │  │  ├─ plan-tools.ts    generate_plan/optimize_plan 工具（包装 workflow 引擎，摘要化输出 + 唯一 planId）
│  │  │  │  ├─ save-knowledge.ts createSaveKnowledgeTool 工具
│  │  │  │  ├─ backend-http.ts  共享 backend HTTP 基建（loadConfig/backendGet）
│  │  │  │  └─ safe-key.ts      sessionKey 转目录 key
│  │  │  ├─ __tests__/         session-aggregate 单测
│  │  │  └─ workflow/           TS workflow 编排引擎（作为 generate_plan/optimize_plan 工具的内部实现，见上）
│  │  │     ├─ orchestrator.ts  generate/optimize 编排（取数→风控→生成→审查→重试）
│  │  │     ├─ llm-leaf.ts      LLM 叶子节点（临时 session、无工具、systemPromptOverride）
│  │  │     ├─ llm-json.ts      共享一次性 LLM JSON 原子（runLlmJsonOnce/runLlmJson）
│  │  │     ├─ context-builder.ts 上下文组装单一出口（resolveScope/fetch/project/serialize）
│  │  │     ├─ customer-summary.ts 客户级会话摘要生成
│  │  │     ├─ prompts.ts       各 LLM prompt 构造（buildInsightPrompt 等）
│  │  │     ├─ insight-batch.ts 批量洞察（runBatchInsight/createInsightLlm/createInsightDeps）
│  │  │     ├─ self-evolve.ts   自进化（runExtractInsightFromPlan/runSuggestKnowledge）
│  │  │     ├─ insight-orchestrator.ts 洞察/知识链路聚合 re-export
│  │  │     ├─ extractors.ts    知识提取（extractKnowledge/extractCandidates）
│  │  │     ├─ case-store.ts    案例库（内存 cosine 检索 + JSON 持久化）
│  │  │     ├─ plan-in-session.ts 会话内方案生成编排（runPlanInSession + 受控并发 runBatchPlanInSessions）
│  │  │     ├─ index.ts         workflow 对外导出
│  │  │     ├─ backend-client.ts backend 取数与合规审查 HTTP 客户端
│  │  │     ├─ retry-context.ts 结构化重试指令构造
│  │  │     ├─ types.ts         类型定义与依赖注入接口
│  │  │     └─ __tests__/       orchestrator + retry-context + llm-leaf 容错/校验单测（vitest）
│  │  ├─ package.json
│  │  └─ tsconfig.json
│  ├─ web/                      前端界面
│  │  └─ src/
│  │     ├─ main.ts             应用主入口（FinanceAdvisorApp 单类）
│  │     ├─ chat-state.ts       对话区纯状态层 ChatSessionState（消息/进行中/贴底判定，可单测）
│  │     ├─ api.ts              HTTP 请求层
│  │     ├─ types.ts            前端请求/响应类型
│  │     ├─ advisor-gateway.ts  SSE 客户端
│  │     ├─ result-parser.ts    SSE 文本抽取
│  │     ├─ markdown.ts         Markdown 渲染（marked）
│  │     ├─ session-title.ts    会话默认标题生成与旧占位名判定（纯函数）
│  │     ├─ render-utils.ts     escapeHtml/money 等渲染工具
│  │     ├─ safe-key.ts         sessionKey 安全化
│  │     ├─ styles.css          银行台账主题样式
│  │     └─ ...                 （含 *.test.ts 单测：chat-state/markdown/result-parser/advisor-gateway/session-title）
│  ├─ backend/                  业务接口与演示数据
│  │  ├─ src/
│  │  │  ├─ server.mjs          HTTP 服务（CORS/鉴权分流/routes 组装/调度启动）
│  │  │  ├─ routes/             领域路由模块（按 public/admin/manager 分发）
│  │  │  │  ├─ index.mjs        registerAll 聚合
│  │  │  │  ├─ auth.routes.mjs  登录/登出/公开改密/me
│  │  │  │  ├─ admin.routes.mjs 客户经理/客户管理 + 分配 + 级联删除
│  │  │  │  ├─ customers.routes.mjs 客户列表/详情/profile/summary/tasks + 画像编辑（含 aum 校验）
│  │  │  │  ├─ products.routes.mjs  eligible/strategies
│  │  │  │  ├─ knowledge.routes.mjs knowledge 读写 + suggest 转发
│  │  │  │  ├─ plans.routes.mjs audit/snapshots
│  │  │  │  ├─ sessions.routes.mjs 会话 CRUD
│  │  │  │  ├─ batch.routes.mjs batch/insight/plans/jobs
│  │  │  │  ├─ insights.routes.mjs insights 列表/新增/extract/confirm/reject
│  │  │  │  ├─ reminders.routes.mjs reminders
│  │  │  │  ├─ market.routes.mjs   市场简报 GET/PUT
│  │  │  │  └─ case-store.routes.mjs 案例库 CRUD
│  │  │  ├─ helpers.mjs         corsHeaders/json/readBody
│  │  │  ├─ forward.mjs         网关转发 forwardGateway
│  │  │  ├─ auth.mjs            认证与 RBAC
│  │  │  ├─ compliance.mjs      合规审查规则
│  │  │  ├─ knowledge.mjs       知识库管理
│  │  │  ├─ store.mjs           数据存储（含 customer_summaries/market_brief 读写）
│  │  │  ├─ strategies.mjs      营销策略规则层
│  │  │  └─ scheduler.mjs       定时调度 + 洞察链路编排（规则层全量 Y1 合并 / LLM 层增量；与方案生成解耦）
│  │  └─ data/seed.json         演示数据（运行时业务数据落 .runtime/data/）
│  ├─ docs/                     设计文档与 API 参考
│  │  ├─ api-reference.md       API 接口文档
│  │  ├─ data-dictionary.md     数据字段字典
│  │  ├─ context-memory-design.md 记忆系统与上下文管理设计
│  │  ├─ knowledge-accumulation-prd.md / tech.md  知识沉淀与案例库 PRD/技术方案
│  │  ├─ customer-insight-implementation-plan.md  客户洞察实现方案
│  │  └─ next-phase-requirements.md  宏观需求基线
│  ├─ scripts/                  启动、停止和状态检查脚本
│  ├─ config.example.json
│  ├─ start.cmd
│  └─ stop.cmd
├─ README.md
└─ .gitignore
```

## 方案生成工作原理

方案生成与优化在**主对话 Agent 会话内**通过 `generate_plan` / `optimize_plan` 工具触发，工具内部调用 TS workflow 编排引擎。流程如下：

1. 客户经理自由聊天输入如「帮张总生成稳健方案」，前端以 SSE POST `{ sessionKey, message, customer_id, manager_id }` 到 pi-gateway `/api/agent/run`
2. 主对话 Agent 在 ReAct 循环中自主决策调用 `generate_plan` / `optimize_plan`（工具参数含 `customer_id` / `manager_id`，optimize 另含 `instruction` 与 `target_plan_id`）
3. `plan-tools.ts` 将工具调用转发到 `runGeneratePlan` / `runOptimizePlan`（orchestrator 纯函数编排）
4. **取数**：`backend-client.ts` 按 `plan` scope 并发调用 backend 接口（客户画像、适配产品、知识库、市场简报），经 `context-builder.ts` 白名单投影 + 紧凑 JSON 序列化，组装 `WorkflowContext`（不注入 strategies）
5. **前置风控闸门**：客户风险承受能力未评估时直接拦截，不调用 LLM
6. **LLM 叶子节点**（`llm-leaf.ts`）：用 `runLlmJson` 创建临时 AgentSession，强制无工具，通过 `systemPromptOverride` 注入 `.pi/agents/plan-generator/AGENTS.md` 作为叶子人设；prompt 注入上下文 JSON + 模式 + 重试指令（若有）+ 相似案例参考（若检索到）+ 目标方案与优化要求（optimize 模式）；LLM 直接输出 `{ "plans": [...] }` JSON，用 `parseJsonWithRepair` 宽松解析（可修复字符串内未转义控制字符），仍失败时叠加启发式修复缺逗号/尾随逗号；随后程序回填产品展示字段（A1/A3）并做结构校验，校验失败时将错误消息反馈给 LLM 自动重试 1 次（最多 2 次调用，反馈不含原始输出）
7. **合规审查**：`backend-client.ts` 调用 backend `/api/plans/audit` 执行 4 项确定性检查（风险等级匹配、产品在售、违禁词、风险揭示语）
8. **重试循环（两层独立）**：a) **LLM 叶子输出容错重试**——解析/结构校验失败时错误反馈重试（最多 2 次，见第 6 步）；b) **合规审查重试**——审查未通过时，`retry-context.ts` 生成结构化修正指令（定位到具体 planId、违禁词、风险揭示语），LLM 逐条修正后重新审查，最多 3 次（含初审）
9. 审查通过后返回方案 JSON（附 `complianceReport`），工具层仅把轻量摘要 `[planId] 标题 评分` 回灌主对话，完整方案经 SSE `tool_result` 的 `details.result` 透传前端，模型可按需调 `get_plan` 取用
10. 对话结束时（节流）刷新客户级会话摘要到 `customer_summaries.json`

**编排边界**：workflow 引擎是 `generate_plan` / `optimize_plan` 工具的内部实现，不独立对外；其直连 backend 取数与审查，LLM 叶子节点无工具无状态，只负责生成方案 JSON。另保留非流式 `POST /api/workflow/run` 供 backend scheduler 定时批量生成。

## 开发验证

前端构建：

```powershell
corepack pnpm@10.23.0 --dir finclaw/web build
```

前端测试：

```powershell
corepack pnpm@10.23.0 --dir finclaw/web test
```

后端单元测试：

```powershell
node --test finclaw/backend/src/compliance.test.mjs finclaw/backend/src/knowledge.test.mjs
```

pi-gateway workflow 编排引擎单测（orchestrator + retry-context，无需启动服务、无需 LLM）：

```powershell
corepack pnpm@10.23.0 --dir finclaw/pi-gateway test
```

## API 文档

完整接口文档见 [finclaw/docs/api-reference.md](finclaw/docs/api-reference.md)，包含登录认证、管理员接口、客户经理接口的请求/响应格式和权限矩阵。

## 安全说明

- DeepSeek API Key 只应保存在本地 `finclaw/.pi/auth.json` 中，请勿提交到 Git
- `finclaw/config.json` 中的 `gateway.authToken` 用于内部服务认证，请勿暴露到公网
- 默认服务仅监听本机地址，不建议未经鉴权直接暴露到公网
- 向他人提供日志或配置前，请先检查并移除客户信息、令牌和密钥
