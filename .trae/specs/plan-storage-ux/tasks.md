# 开发任务分解

> 基于 `.trae/specs/plan-storage-ux/spec.md` 需求规格。
> 硬约束：方案工具返回 `content` 只含摘要（不注入完整 JSON）；前端方案卡渲染走 `details.result` 通道。

## 阶段 1：后端存储与快照（后端 + 工具层）

- [ ] **T1.1 快照自动存档接口**：确认后端 `POST /api/plans/snapshots` 已存在（已确认，见 store.mjs），确保 `saveSnapshot` 幂等或按 planId 去重（同一 planId 不重复落盘）
- [ ] **T1.2 工具 content 摘要化**：修改 `plan-tools.ts` 的 `executePlanTool`，将 `content` 从完整 JSON 围栏改为摘要列表（planId/title/score/一句话/状态）；`details.result` 保留完整对象
- [ ] **T1.3 快照自动存档触发**：前端 `handlePlanToolResult` 中调用 `POST /api/plans/snapshots` 自动保存本轮方案（与 `persistSession` 并行）
- [ ] **T1.4 快照去重**：同一会话内同一 planId 只落一份快照（防止多次渲染重复存档）

## 阶段 2：按需取用工具（gateway 层）

- [ ] **T2.1 新增 `get_plan` 工具**：定义参数 `plan_id`，执行逻辑从 snapshots.json 或 backend 按 planId 查完整方案，返回完整 MarketingPlan 对象
- [ ] **T2.2 注册工具**：在 `createCustomTools` 中注册 `get_plan`
- [ ] **T2.3 单测**：为 `get_plan` 编写 node --test 单测，覆盖命中/未命中/错误分支

## 阶段 3：聚合历史改造（gateway 层）

- [ ] **T3.1 `session-aggregate.ts` 调整**：`aggregateSessionEntries` 不再从文本解析完整 JSON（无 JSON 围栏了），`plans` 数据改从 `tool_execution_end` 事件的 `details.result` 提取
- [ ] **T3.2 单测**：更新 `session-aggregate` 相关单测，验证摘要文本不再被当作完整方案解析、plans 通道正常

## 阶段 4：前端数据模型与 UI 收敛（web 层）

- [ ] **T4.1 `types.ts` 增加 `adoptedPlanId`**：`PlanSession` 新增可选字段
- [ ] **T4.2 收敛逻辑 `plansHtml`**：
  - 有 `selectedPlanId` 时：`当前关注`（选中方案大卡片）+ `历史方案 (N)` 折叠区
  - 无 `selectedPlanId` 时：3 套原始方案平铺（初始状态）
  - 优化落地自动选中后自动收敛（Q9）
- [ ] **T4.3 折叠区交互**：展开/收起；点击历史方案"选择"切回为焦点（该方案升为当前关注，旧关注收进历史）
- [ ] **T4.4 成交标记按钮**：仅"当前关注"大卡片显示 `[标记成交]`，历史卡不显示
- [ ] **T4.5 二次确认 + adoptedPlanId 持久化**：点击弹确认框，确认后置 `adoptedPlanId` 并 `persistSession`，卡片显示"已成交"徽标
- [ ] **T4.6 移除旧"采用方案"按钮**：推荐方案卡片上的 `accept-plan` 按钮移除，替换为 `标记成交`（仅当前关注卡）
- [ ] **T4.7 一键发送调整**：`sendPlanScript` 仅"当前关注"大卡片可触发（现状已要求先选中方案，无需大改，确认无回归即可）
- [ ] **T4.8 CSS 收敛样式**：当前关注大卡片 / 历史方案折叠区 / 已成交徽标 / 展开态网格布局

## 阶段 5：验证

- [ ] **T5.1 单元测试**：`node --test`（gateway 工具、聚合）、`vitest run`（web）
- [ ] **T5.2 构建**：`tsc`、`vite build` 通过
- [ ] **T5.3 端口测试**：按约定启动 backend(3001)/gateway(18789)/web(4174)，验证：
  - generate_plan 返回 3 套，工具 `content` 为摘要（无完整 JSON）
  - optimize_plan 自动选中新方案并收敛
  - 标记成交二次确认 + 已成交徽标 + adoptedPlanId 持久化
  - 历史方案折叠区展开/切回焦点
- [ ] **T5.4 浏览器 UI 验证**：交由用户自行验证