# 验收清单

> 对应 `.trae/specs/plan-storage-ux/spec.md` 需求。逐项打勾。

## 存储与上下文

- [ ] 每次 generate_plan / optimize_plan 结果落地自动写入 snapshots.json（不依赖"选择"动作）
- [ ] 同一 planId 不重复落盘（去重）
- [ ] 工具 `content` 为摘要列表，不含完整 JSON（无 ```json 围栏）
- [ ] `details.result` 仍含完整方案对象（前端卡片渲染可用）
- [ ] 新增 `get_plan(plan_id)` 工具已注册，能返回完整方案
- [ ] `session-aggregate` 不再从文本解析完整 JSON，plans 走 details.result 通道
- [ ] 历史会话回看（切换客户/会话）时，方案卡片仍能完整还原

## 推荐方案界面收敛

- [ ] 初始无选中时，3 套原始方案平铺
- [ ] 选中方案后，未选中方案收进"历史方案 (N)"折叠区，选中方案常驻"当前关注"大卡片
- [ ] 优化落地自动选中新方案后，界面收敛，旧方案（原始 3 套 + 旧优化版）全部收进历史折叠区
- [ ] 历史折叠区可展开/收起
- [ ] 历史折叠区点击某方案可切回为焦点（旧关注收进历史）
- [ ] compare 功能原样保留（未受影响）

## 成交标记（占位）

- [ ] "标记成交"按钮仅"当前关注"大卡片显示，历史折叠区方案卡不显示
- [ ] 点击弹出二次确认框：「确认该客户已决定购买本方案并进入成交？」
- [ ] 确认后 `adoptedPlanId` 写入并持久化到 session
- [ ] 已成交方案显示"已成交"徽标
- [ ] 已成交方案切回焦点时徽标保留
- [ ] 旧"采用方案"(accept-plan → 提洞察) 按钮已移除
- [ ] 触发逻辑为空实现（占位），无未完成调用

## 数据模型

- [ ] `PlanSession` 新增 `adoptedPlanId` 可选字段，且 `selectedPlanId` 语义不变
- [ ] 切换客户/会话后 adoptedPlanId 正确加载并恢复徽标

## 质量门禁

- [ ] `node --test`（gateway 工具、聚合）通过
- [ ] `vitest run`（web）通过
- [ ] `tsc` 通过
- [ ] `vite build` 通过
- [ ] 端口测试：backend(3001)/gateway(18789)/web(4174) 健康，SSE 事件正常
- [ ] 浏览器 UI 验证（用户自行）通过

## 遗留（本期明确不做）

- [ ] 洞察触发逻辑（extractInsight 与"标记成交"联动）—— 后续开发
- [ ] 洞察 `source` 改名 `"accepted"` → `"adopted"` —— 与触发逻辑一起做
- [ ] 触客硬门槛（一键发送记录 + 标记成交校验）—— 后续开发
- [ ] compare 功能调整 —— 不在本期范围