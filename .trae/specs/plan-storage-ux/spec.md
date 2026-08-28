# 方案存储与交互优化（Plan Storage & UX Polish）

## 概述

对方案从生成到迭代优化的全生命周期进行重构，主要解决三个问题：

1. **上下文膨胀**：完整方案 JSON 全量堆叠注入模型上下文，导致 token 浪费
2. **推荐界面不收敛**：历史方案全部平铺，迭代越多界面越臃肿
3. **动作语义模糊**：经理"选取"与客户"成交"共用同一洞察触发入口，噪声大

## 设计决策（已对齐）

### 存储层

| 决策 | 结论 | 说明 |
|------|------|------|
| Q1 快照触发时机 | 每次 generate_plan / optimize_plan 结果落地时自动全量存档 | 不依赖"选择"动作，不重复存 |
| Q2 方案主存储归一 | snapshots.json 作为唯一全量快照源；session 只存"当前关注"方案 + 摘要引用 | 减少重复大对象，以 planId 为引用键 |

### 上下文层

| 决策 | 结论 | 说明 |
|------|------|------|
| Q3 工具 content 形态 | 改为文字摘要 + 轻量列表（planId / title / score / 一句话 / 状态），不再注入完整 JSON | 工具返回的 `content` 只含摘要，`details.result` 仍保留完整对象供前端 |
| Q4 按需取用工具 | 新增 `get_plan(plan_id)` 工具 | 模型需要完整方案细节时自行调用；optimize_plan 内部仍按 target_plan_id 自动捞取 |
| Q5 聚合历史喂模型 | 历史会话聚合后只喂摘要列表（不含完整 JSON） | 前端 UI 渲染用的 plans 数据不受影响，仍完整 |

### 交互层

| 决策 | 结论 | 说明 |
|------|------|------|
| Q6 未选中方案收敛 | 点"选择方案"后，未选中方案收进可展开的"历史方案"折叠区 | 可随时展开、切回任意历史版本为焦点 |
| Q8 折叠区入口 | 推荐方案 Tab 顶部"当前关注"大卡片，其下接"历史方案 (N)"折叠区 | 可展开、可点击切回焦点，不可对其标记成交 |
| Q9 迭代采纳后行为 | optimize_plan 落地自动选中新方案后，界面收敛：新方案升为"当前关注"大卡片，所有旧方案（原始 3 套 + 所有旧优化版）收进"历史方案"折叠区 | 突出当前关注 |
| R3 Compare | 本次不碰，原样保留 | 范围内不扩展 |

### 动作语义层

| 决策 | 结论 | 说明 |
|------|------|------|
| Q7a 动作三分 | ① 选择方案 → 仅置 selectedPlanId + 收敛 UI；② 继续优化 → 输入框发送即优化当前选中；③ 标记成交 → 唯一触发洞察入口 | 三者独立 |
| Q7b 成交门槛 | 二次确认弹窗："确认该客户已决定购买本方案并进入成交？" | 不做强制填表 |
| Q7c 数据模型 | PlanSession 新增 `adoptedPlanId` 字段，独立于 `selectedPlanId` | 已成交方案显示"已成交"徽标 |
| Q7d 洞察来源改名 | `source` 从 `"accepted"` 改为 `"adopted"` | 留到触发逻辑开发时再改 |
| R1 触客门槛 | 本期不做硬门槛，按钮随时可点 | 仅把控位置和语义正确 |
| R2 按钮替换 | 从推荐方案卡片上移除旧"采用方案"按钮，替换为"标记成交" | 仅"当前关注"大卡片显示；历史折叠区方案卡不显示 |

## 详细需求

### 1. 快照自动存档

**触发**：每次 `executePlanTool` 成功返回（generate_plan 或 optimize_plan），在 `details.result` 中有完整方案数据时，自动调用 `POST /api/plans/snapshots` 将每套方案写入 snapshots.json。

**每个快照记录结构**：

```json
{
  "id": "uuid",
  "createdAt": "ISO 8601",
  "planId": "string",
  "customerId": "string",
  "managerId": "string",
  "title": "string",
  "score": "number",
  "tags": "string[]",
  "diagnosis": "string",
  "allocation": "Record<string, { pct, products }>",
  "products": "Array<{ productId, name, category, riskLevel, reason }>",
  "scripts": "{ wecom, phone }",
  "markdown": "string",
  "generation": "initial | optimize",
  "instruction": "string | null",
  "adopted": false
}
```

**执行位置**：前端 `handlePlanToolResult` 同步调用 `POST /api/plans/snapshots`（快照存储），与 `persistSession` 并行。

### 2. 上下文注入改造

**工具 content 摘要格式**（替代当前完整 JSON 围栏）：

```markdown
已为客户生成 3 套方案（含合规审查）。

- 方案 A [plan_a1b2c3] 稳健增值配置 · 85 分 · 重点关注防御型资产
- 方案 B [plan_d4e5f6] 进取成长配置 · 78 分 · 侧重权益类产品
- 方案 C [plan_g7h8i9] 平衡混合配置 · 82 分 · 攻守兼备

合规审查：全部通过
```

**新增 `get_plan` 工具**：

```typescript
{
  name: "get_plan",
  description: "获取指定方案的完整详情（含资产配置、产品列表、话术脚本、合规报告）。模型需要引用方案具体数据时调用。",
  parameters: {
    plan_id: { type: "string", description: "方案 ID" }
  },
  execute: async (planId) => {
    // 从 snapshots.json 或 backend 按 planId 查询完整方案
    // 返回完整 MarketingPlan 对象
  }
}
```

**聚合历史改造**：`session-aggregate.ts` 的 `aggregateSessionEntries` 方法中，识别工具返回的摘要文本（不再包含完整 JSON 围栏），直接保留原样不解析。`plans` 字段从 Pi SDK 的 `tool_execution_end` 事件结果中提取（走 `details.result` 通道），而非从文本解析。

### 3. 推荐方案界面收敛

**布局结构**：

```
┌─ 推荐方案 ─────────────────────────────┐
│                                         │
│  ┌── 当前关注 ──────────────────────┐  │
│  │  [大卡片 - 被选中方案]            │  │
│  │  [标签: 已成交?] [标记成交] [发送]│  │
│  └──────────────────────────────────┘  │
│                                         │
│  ┌── 历史方案 (N) ───── [展开 ▼] ──┐  │
│  │  (折叠时隐藏)                     │  │
│  │  (展开时显示 N 套历史方案小卡片)  │  │
│  └──────────────────────────────────┘  │
│                                         │
│  [对比按钮]                             │
└─────────────────────────────────────────┘
```

**行为规则**：

- **初始状态**：无选中方案时，3 套原始方案平铺（保留现状，因无"当前关注"）
- **选中方案后**：立即收敛，选中的卡升为"当前关注"大卡片，其余套进"历史方案"
- **历史折叠区展开**：以小卡片（类似气泡内 compact 卡）展示，可点击"选择"切回为焦点（切回后该方案升为"当前关注"，被取代的旧关注收进历史）
- **优化迭代后**：新方案成为"当前关注"，在此之前所有方案（原始 3 套 + 旧优化版）全部收进"历史方案"
- **"标记成交"按钮**：仅"当前关注"大卡片上显示；历史折叠区方案卡不显示

### 4. 成交标记占位

**UI 位置**：推荐方案界面"当前关注"大卡片底部，三个按钮——`[详情] [标记成交] [一键发送]`。

**点击流程**：

1. 弹二次确认框：「确认该客户已决定购买本方案并进入成交？」
2. 确认后：
   - 置 `session.adoptedPlanId = planId`
   - 自动调用 `persistSession` 持久化
   - 卡片显示"已成交"徽标
   - 触发逻辑（洞察提取等）**置空占位**，后续开发
3. 取消则无变化

**已成交状态**：已成交方案被切回为焦点时，保留"已成交"徽标不可移除；已成交方案被新方案取代收进历史后，仍保留历史徽标。

### 5. 数据模型变更

**PlanSession 新增字段**：

```typescript
export interface PlanSession {
  // ... 现有字段不变
  adoptedPlanId?: string;  // 新增：已成交方案的 planId（独立于 selectedPlanId）
}
```

**MarketingPlan / 快照暂不新增字段**（adopted 状态由 session 层记录，不下沉到方案对象）。

### 6. 排除范围

- 本次不改 `compare` 功能
- 本次不改洞察 `source` 命名（`"accepted"`→`"adopted"` 留到触发逻辑开发时）
- 本期不做触客硬门槛（一键发送不落记录，标记成交不校验是否已发送）
- 本期不做 insight 提取逻辑