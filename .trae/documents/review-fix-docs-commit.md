# 计划：Review 本轮代码 → 修复推荐项 → 同步文档 → 一次性提交

## Summary
对当前分支 `feature/refactor-workflow-impl` 上**未提交的本轮改动**（相对 `33a52e76e`）做一次简单 review；修复审查发现的必要项（以提交卫生为主，未发现确凿代码 bug）；同步更新 README 与 docs 目录文档以匹配最新实现；最后将本轮全部代码与文档改动一次性提交。

## Current State Analysis
- 未提交改动：17 个已修改文件（+630/-121 行），新增多个文件（`session-aggregate.ts`、`session-title.ts`、`markdown.ts`、`get-plan.test.ts`、`session-aggregate.test.ts`、`session-title.test.ts`、`markdown.test.ts`、`.trae/specs/{chat-ux-polish,plan-storage-ux,session-title-edit}/`）。
- 本轮功能：方案摘要化注入 + `get_plan` 按需取用、快照自动存档（按 planId 幂等）、推荐方案"当前关注 + 历史折叠"布局、`adoptedPlanId` 成交标记、会话标题默认命名「客户名 - 营销会话 - YYYYMMDD」+ 行内编辑。
- 已并行执行两路 review（web 侧、backend/pi-gateway 侧），并结合人工核对关键代码。**结论：未发现确凿 bug**。review 代理报告的条目多为臆测，已逐条核验为误报：
  - `sendMessage` 未同步 `adoptedPlanId` → 非问题（该字段由 `confirmAdoptPlan → persistSession` 独立管理）
  - `loadSessionChat` 中 selectedPlanId 不一致 → 非问题（`applySession` 先恢复 `this.plans`，`plansFromSummary` 基于 `this.plans` 匹配正确）
  - `editingSessionId` 未清理 → 误报（`cancelEditTitle`/`commitEditTitle` 均已清空两个字段）
  - `session-aggregate` 未过滤非文本 content → 误报（`contentText` 已抽取文本）
  - `get_plan` 空数组无友好提示 → 误报（已有 `!record` → "方案不存在"）
  - `plan-tools` planId 改写格式风险 → `target_plan_id` 为工具必填参数，低风险，不额外加防护（遵循简洁优先）
- 确认的**真实待处理项**（提交卫生）：
  1. 根目录 `.pi/auth.json`（内容为 `{}`，空）未跟踪且未被 .gitignore 覆盖 → 一次性 `git add -A` 会被误提交。
  2. `finclaw/pi-gateway/.runtime/`（仅 `tmp/sse-test-*.json|txt` 调试残留）未跟踪且未忽略。
  3. `finclaw/pi-gateway/scripts/diag-tools.ts` 为一次性调试脚本（注释自述"仅用于排查"），无 package.json script 引用 → 建议删除（符合"死代码移除"约定）。

## Proposed Changes

### 1. 提交卫生（fix 推荐项）
**文件：`.gitignore`**
- 追加两行：
  ```
  # Local pi agent root (root-level empty auth.json leftover)
  .pi/
  # Gateway runtime scratch
  finclaw/pi-gateway/.runtime/
  ```

**文件：删除 `finclaw/pi-gateway/scripts/diag-tools.ts`**
- 一次性诊断脚本，删除后 `finclaw/pi-gateway/scripts/` 目录一并清空（无其他引用）。

### 2. 文档同步
**文件：`README.md`**
- 「主要功能」补充：① 会话标题默认命名「客户名 - 营销会话 - YYYYMMDD」并在历史会话卡行内重命名；② 方案快照自动存档（`snapshots.json`，按 planId 幂等去重）；③ 推荐方案界面"当前关注大卡片 + 历史方案折叠"布局，已采纳方案可「标记成交」（`adoptedPlanId`，洞察触发逻辑置空待开发）；④ 对话界面保存全部方案历史，模型上下文仅注入轻量摘要，`get_plan(plan_id)` 按需取完整方案。
- 「项目目录」更新：web 下补 `session-title.ts`、`markdown.ts`（含同名 `.test.ts`）；pi-gateway 下补 `session-aggregate.ts`、`tools/plan-tools.ts`、`tools/customer-analyze.ts`（get_plan 工具）、`src/__tests__/`、`scripts/`（如删除后不再列出）。
- 「方案生成工作原理」第 5 步后补充一句：方案生成/优化通过自定义工具 `generate_plan`/`optimize_plan` 注册进主对话 Agent，工具返回轻量摘要，完整方案经 `details.result` 透传前端、`get_plan` 供模型取用。

**文件：`finclaw/docs/api-reference.md`**
- 客户经理接口下新增「会话管理 API」小节：`GET /api/sessions?customerId=`、`GET /api/sessions/:sessionId`、`POST /api/sessions`（body `{customerId, title?}`）、`PUT /api/sessions/:sessionId`（body 白名单：`plans/selectedPlanId/adoptedPlanId/lastInstruction/complianceReport/title`）、`DELETE /api/sessions/:sessionId`，注明权限（仅名下客户）。
- 更新「3.11 保存方案快照」请求体为扁平字段：`planId/customerId/managerId?/title/score/tags/diagnosis/allocation/products/scripts/markdown/generation?/instruction?/adopted?`，并注明按 planId 幂等更新。
- 「4. 权限矩阵」补充 `/api/sessions` 行（401/403/可用）。

**文件：`finclaw/docs/data-dictionary.md`**
- 「2. 运行时数据文件」更新 `snapshots.json` 结构为扁平 Snapshot（`{ id, createdAt, updatedAt, planId, customerId, managerId, title, score, tags, diagnosis, allocation, products, scripts, markdown, generation, instruction, adopted }`），并注明按 planId 幂等更新（保留 id/createdAt）。
- 新增 `plan_sessions.json` 行：`{ sessions: PlanSession[] }`，`PlanSession = { sessionId, customerId, managerId, sessionKey, title, createdAt, updatedAt, plans, selectedPlanId, adoptedPlanId, lastInstruction, complianceReport }`。
- 更新快照创建说明（`store.mjs saveSnapshot`，幂等覆盖）。
- 「6. 网关 SSE 协议」：入口更新为自由对话（`POST /api/agent/run`，`message` 为纯文本；`agent-session.ts` 自动注入 `[会话上下文]`），移除 `{action,payload}` 旧协议描述。
- 「7.2 环境变量」补充：`FINANCE_AGENT_ID`（默认 wealth-advisor）、`FINANCE_DEFAULT_MANAGER`（默认 MGR_001）。

### 3. 一次性提交
- 用**定向 `git add`**（按文件名，禁止 `-A`）暂存：17 个已修改文件 + 上述新增文件（`session-aggregate.ts`、`session-title.ts`、`markdown.ts`、`*.test.ts`、`.trae/specs/{chat-ux-polish,plan-storage-ux,session-title-edit}/`）+ `.gitignore` + 文档改动。**不包含** 根 `.pi/`、`finclaw/pi-gateway/.runtime/`（已忽略）、被删除的 `diag-tools.ts`。
- 提交信息建议：`feat: 方案快照存档与成交标记,会话标题编辑,文档同步`（或按仓库现有中文 style 微调）。
- 不 push（用户未要求）。

## Assumptions & Decisions
- 假定 `.trae/specs/` 下三个新 spec 目录按现有约定（已有 specs 均被跟踪）一并提交。
- `diag-tools.ts` 按 review 建议删除；若用户希望保留，可在批准时说明，改从提交中排除而非删除。
- 根 `.pi/` 内容为空 `{}`，无密钥；`finclaw/.pi/auth.json` 含真实 Key 且已被 gitignore，不会进入本次提交。
- 文档同步范围为 README + `docs/api-reference.md` + `docs/data-dictionary.md`（其余 `login-feature-design.md`、`rbac-design.md`、`next-phase-*.md` 与本轮无直接变更，不改动）。

## Verification
1. 测试：`corepack pnpm@10.23.0 --dir finclaw/web test`；`corepack pnpm@10.23.0 --dir finclaw/pi-gateway test`；`node --test finclaw/backend/src/compliance.test.mjs finclaw/backend/src/knowledge.test.mjs` 全部通过。
2. 构建：`corepack pnpm@10.23.0 --dir finclaw/web build`；`corepack pnpm@10.23.0 --dir finclaw/pi-gateway build` 成功。
3. `git status` 复核：仅预期文件被暂存，`git diff --cached --stat` 与清单一致；根 `.pi/`、`pi-gateway/.runtime/` 未被跟踪。
4. 复核 README/docs 与代码一致（如 `adoptedPlanId`、`sessionKey`、`plan_sessions.json`、env 变量名）。
