# 客户洞察功能实现方案（grill-me 共识版 v1.0）

> 状态：**已实施**（2026-08-16 完成，代码已按本方案落地并通过验证）
> 日期：2026-08-16
> 前置分析：`customer-insight-data-analysis.md`（数据现状 + 快照机制解析）
> 核心约束：**客户洞察与方案生成模块保持解耦**（用户明确要求）

> 实施记录：`store.mjs` 新增 `mergeTasksForCustomer`（Y1）；`scheduler.mjs` 定时链路全局化（T2）+ 移除③批量方案生成（解耦）+ 规则层全量重算；`customers.routes.mjs` profile 附加 tasks；`insights.routes.mjs` confirm 触发该客户任务 Y1 重算；`web/src/main.ts` 提醒区动态策略标签（U1）、筛选口径（S1）、近期任务（R1）、60s 轮询（F1）、洞察跳过提示（P1）、任务计数排除 account_review（A1）。验证：后端单测 5 过、前端单测 14 过、vite transform 通过、Y1 合并与标签统计集成验证通过。

---

## 1. 需求概述（经理视角）

1. 提醒区显示**策略标签**：= `strategies.mjs` 12 条策略的命中统计，按 `priority` 降序，**只显示有客户命中的策略**，点击标签筛选出命中的客户。
2. 洞察触发方式两种：**每天 9:00 定时**（对全部客户）+ **多选客户点击「客户洞察」**（对勾选客户）。
3. 客户列表的**任务数量随洞察结果变化**；客户画像的「近期任务」区域显示该客户的**策略任务**（不再是 `upcomingMaturities` 老数据）。
4. 洞察生成后由客户经理**确认或驳回**；**确认洞察 → 更新该客户近期任务列表**（策略任务刷新）。

---

## 2. 决策清单（11 项共识）

| # | 决策点 | 结论 | 说明 |
|---|---|---|---|
| Q1 | 标签定义 | **12 策略命中统计**，`priority` 降序，只显示有客户的策略 | 参考 `strategies.mjs::STRATEGIES`，非用户最初提的 6 类 |
| Q2 | 快照合并语义 | **方案 1 按客户合并** | 每客户"最近一次被洞察"的结果；`customer_tasks.json` 覆盖式快照天然满足 |
| Q3 | 标签数据源 | **路线 A：读 `customer_tasks.json`**（列表接口附加的 tasks），**只统计 pending** | 零新增存储，与"X任务"标签同源 |
| Q4 | 任务刷新策略 | **方案 Y1：规则层每轮全量重算 + 按 `strategyType` 合并** | 已存在且非 pending 的任务保留原状态；新命中追加 pending；不再命中删除 |
| Q5 | 画像"近期任务" | **R1：纯策略任务**（pending、非 account_review、按 priority 排序，显示 `strategyName`+`triggerCondition`） | 替换现有 `upcomingMaturities` 渲染 |
| Q5 | 确认洞察动作 | **C1：`confirmInsight` + 该客户规则任务 Y1 重算 + 前端重拉 profile** | 确认 → 近期任务变为对应策略，闭环成立 |
| Q6 | 定时触发 | **保持 9:00** + **T2 全局跑**（全部客户，不依赖 MGR_ADMIN 分配） | 修复现状"定时链路空跑" |
| Q6 | 解耦约束 | **定时链路只跑洞察**（①规则+②归并），**③ 批量方案生成不接入** | 洞察代码与方案生成模块解耦 |
| Q7 | pending 洞察交互 | **P1：LLM 洞察层保留 pending 跳过；规则层任务照常 Y1 重算**；跳过时 toast 提示 | 避免待确认卡堆积 |
| Q8 | `account_review` | **A1：展示层统一过滤**（标签统计 / 近期任务 / 列表任务数都排除），规则层不动 | 无条件全命中策略无信息量 |
| Q9 | 提醒区布局 | **U1：动态策略标签区 + 保留「待确认洞察」chip**；删掉 batch / audit / dormant 三个固定 chip | batch 与方案生成耦合、audit 死逻辑、dormant 与策略标签重复 |
| Q10 | 点击筛选口径 | **S1：前端内存过滤** `tasks.some(t => t.strategyType === key && t.status === 'pending')` | 与标签计数同源，避免"显示 5 人筛出 4 人" |
| Q11 | 前端刷新 | **F1：60s 轮询** `reminders` + `customers`，计数变化时 toast 提示 | 让 9:00 定时结果自动上屏 |

---

## 3. 数据口径定义（实现必须一致遵守）

**统一口径：策略任务 = `tasks[]` 中 `status === 'pending'` 且 `strategyType !== 'account_review'` 的任务。**

| 界面元素 | 口径 | 数据源 |
|---|---|---|
| 提醒区策略标签（如"产品到期承接 9"） | 按 `strategyType` 统计 pending 任务数（排除 account_review），有客户才显示，按 `priority` 降序 | `GET /api/customers` 附加的 `tasks` |
| 点击标签筛客户 | `tasks.some(t => t.strategyType === key && t.status === 'pending')`，多标签 OR | 同上（前端内存过滤） |
| 客户列表"X任务" | pending 任务数（排除 account_review） | 同上 |
| 画像「近期任务」区域 | pending 策略任务（排除 account_review），按 `priority` 降序，显示 `strategyName` + `triggerCondition` | `GET /api/customers/:id/profile`（**需新增附加 tasks**） |
| 待确认洞察 chip | 名下客户 `insightPending` 计数 | `GET /api/reminders` |
| 任务快照写入 | Y1 合并（保留非 pending 状态） | `setTasksForCustomer` → 新 `mergeTasksForCustomer` |

---

## 4. 后端改动点（backend，端口 3001）

### 4.1 `src/scheduler.mjs`（定时链路改造）
1. **T2 全局化**：`runDailyChain` 改为直接对 `seed.customers` 全部客户执行（当前传 `"MGR_ADMIN"` 拿不到分配客户 → 空跑，需修复）。
2. **链路解耦**：定时只执行 ① 洞察（规则层 + LLM 层）+ ② 归并 pending 任务；**③ 批量方案生成（`runBatchPlansStage`）从定时链路移除**（保留 `triggerBatchPlans` 手动入口，与洞察互不依赖）。
3. `runBatchInsightStage` 拆分规则层与 LLM 层刷新逻辑：
   - **规则层**：对目标客户**全量** `evaluateCustomers`（移除"画像未变跳过"对规则层的作用）→ 写 tasks 用 **Y1 合并**（新 store 函数）；
   - **LLM 层**：保留增量过滤（`latestStatus === 'pending'` 跳过、`hasProfileChanged` 跳过）→ 跳过客户在 job 的 `skipped` 里带 `reason`，供前端提示。
4. 时间配置保持 `SCHEDULE_HOUR=9, SCHEDULE_MINUTE=0`（现状，不改）。

### 4.2 `src/store.mjs`（任务合并写入）
1. 新增 **`mergeTasksForCustomer(customerId, newTasks)`**（Y1）：
   - 对每个 `newTasks`（按 `strategyType`）：
     - 已存在同 strategyType 任务且 `status !== 'pending'` → **保留原任务**（不重置状态）；
     - 已存在同 strategyType 且 `status === 'pending'` → **更新** triggerCondition/createdAt（刷新内容）；
     - 不存在 → **追加**（`status:'pending'`，source 按来源）。
   - 旧快照中**本轮未命中的 strategyType** → 删除（任务反映最新命中集合）。
2. `getReminders`：保留 `insightPending`（前端仍用）；`batchCompleted`/`auditPending`/`awakenSuggestion` 前端不再展示，字段可保留（兼容）或后续清理（建议保留，避免破坏其他调用）。

### 4.3 `src/routes/customers.routes.mjs`（profile 接口）
1. `GET /api/customers/:id/profile` 响应**附加 `tasks` 字段**（`store.getTasksForCustomer(customerId)`），供前端画像「近期任务」使用（当前仅合并 tags）。
2. 列表接口无需改动（已附加 tasks）。

### 4.4 `src/routes/insights.routes.mjs`（确认洞察动作 C1）
1. `PUT /api/insights/:id/confirm`：确认后**触发该客户规则任务 Y1 重算**（`evaluateCustomer(customer)` → `mergeTasksForCustomer`），返回 `{ ...insight, tasks }` 或单独刷新接口，保证"确认 → 近期任务更新"闭环。
2. `reject` 保持现状（仅置状态，不做任何任务联动）。

### 4.5 不动
- `src/strategies.mjs`（12 策略定义、评估函数一律不动，`account_review` 保留在规则层，展示层过滤）。
- `src/routes/products.routes.mjs` / `batch.routes.mjs`（手动触发入口已满足：`POST /api/batch/insight` 传 customerIds）。

---

## 5. 前端改动点（web，端口 4174）

### 5.1 `src/main.ts`
1. **`reminderBarHtml()`（U1）**：
   - 保留「待确认洞察」chip（计数 `reminders.insightPending`）；
   - 新增**动态策略标签区**：从 `this.customers` 聚合 `tasks`（pending、非 account_review）按 `strategyType` 计数，按 `STRATEGIES` 的 priority 降序渲染，计数为 0 不渲染；label 用 `strategyName`（从任务自带字段取）；
   - 删除 batch / audit / dormant 三个固定 chip。
2. **`matchReminderFilter()`（S1）**：改为 `item.tasks?.some(t => t.strategyType === key && t.status === 'pending')`；标签 key = `strategyType`。
3. **`customerListHtml()`（A1）**：`taskCount` 过滤 `t.strategyType !== 'account_review'`。
4. **`profileHtml()`（R1）**：「近期任务」区域改为渲染 `customer.tasks`（pending、非 account_review、按 priority 降序），条目显示 `strategyName`（标题）+ `triggerCondition`（副行）；无任务显示"暂无策略任务"。
5. **`confirmInsightAction()`（C1）**：确认后**重新拉取当前客户 profile**（含 tasks）并渲染画像（而非仅 toast）。
6. **`selectCustomer()/loadProfile()`**：profile 响应含 tasks 时存入 `this.customer`。
7. **60s 轮询（F1）**：`setInterval` 拉 `getReminders()` + `listCustomers()`，若 `insightPending` 或标签计数发生变化 → 更新状态 + toast 提示（轻量，复用现有 render）。
8. **`doBatchInsight()`（P1）**：toast 细化——成功/失败/**跳过（含 reason=pending 的客户数）**，沿用现有 `result.results.skipped`。

### 5.2 `src/types.ts`
- `CustomerProfile` 补 `tasks?: MarketingTask[]`（继承自 CustomerSummary 已有，确认类型即可；若缺失则显式声明）。

### 5.3 不动
- `src/api.ts`（接口已存在：listCustomers / getReminders / getCustomer / confirmInsight / triggerBatchInsight）。

---

## 6. 解耦约束（硬性）

1. 定时链路与手动按钮**只触发洞察**（规则层任务 + LLM 洞察），**不调用方案生成**。
2. `runBatchPlansStage` / `triggerBatchPlans` 保持独立，仅由「方案生成」入口触发；洞察代码不依赖其内部实现。
3. 洞察相关新增代码（Y1 合并、profile 附加 tasks、确认重算）集中在 store / scheduler / insights routes，不侵入 workflow / 方案生成模块。
4. 提醒区不再展示方案生成相关状态（删除"批量方案完成"chip）。

---

## 7. 验证方式

| 场景 | 步骤 | 预期 |
|---|---|---|
| Y1 合并单测 | 构造已有 done 任务 + 新命中/失效策略 | done 状态保留、新命中追加 pending、失效删除 |
| 手动洞察刷新任务 | 勾选客户点「客户洞察」 | `customer_tasks.json` 对应客户按 Y1 更新；列表"X任务"变化；标签计数变化 |
| 标签筛选 | 点击策略标签 | 只显示 pending 命中该策略的客户；多标签 OR |
| 确认洞察闭环 | 确认待确认洞察 | 洞察置 confirmed + tags 沉淀；该客户近期任务区域刷新为策略任务 |
| 定时链路 | 手动触发 `runDailyChain`（或调时验证） | 全部客户任务 Y1 刷新；**不产生批量方案 job** |
| pending 跳过 | 有 pending 洞察客户再次点洞察 | LLM 层跳过并提示；规则层任务照常刷新 |
| account_review | 查看标签/列表/画像 | 三处均不出现"账户定期检视" |

---

## 8. 风险与边界

1. **快照过期残留（机制固有）**：规则层每轮全量重算后，时间敏感任务（生日/到期）随轮次刷新，过期窗口由 `DEFAULT_CONFIG`（birthdayWindowDays=7、maturityDays=90）决定；LLM 洞察层仍受 pending 跳过影响。
2. **并发写**：store JSON 文件无锁，定时 9:00 与手动洞察若并发会最后写赢；建议入口处加简单互斥（如单例执行标记），或接受现状（9:00 定时通常无人操作）。
3. **`hasProfileChanged` 哈希更新时机**（LLM 层增量依据）：维持现状（`addInsight` 时更新），不改变。
4. **CUST_010 类历史脏数据**：实施后首轮全量重算会自然覆盖修复。
