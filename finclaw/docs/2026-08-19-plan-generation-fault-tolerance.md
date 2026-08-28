# 2026-08-19 方案生成容错增强记录

本会话围绕「批量方案生成偶发失败」完成了 LLM 叶子节点输出链路的容错增强，参考市场项目（langchain / jsonrepair / LLM structured output 等领域）的常见做法，落地三层防御。本文档记录背景、方案、改动与验证结果。

---

## 一、背景与根因

批量方案生成勾选 3 个客户，2 个失败，失败原因两类：

1. **JSON 语法错误**（CUST_002）：`Expected ',' or ']' after array element in JSON at position 3713`
   - LLM 输出的 `plans` 数组元素之间缺失逗号，`parseJsonWithRepair`（仅修复字符串内未转义控制字符与无效转义序列）无法修复
2. **选品与配置不一致**（CUST_004）：`方案 allocation.固收类理财.products 含未选产品名: P008`
   - LLM 在 `allocation` 中引用了 `products` 列表中未选择的产品名称，违反一致性校验

---

## 二、分层防御方案（参考业界实践）

| 层级 | 手段 | 作用 |
|---|---|---|
| 源头约束 | Prompt 强约束（选品一致性） | 降低 LLM 犯错概率 |
| 硬约束 | 程序回填 + 结构校验（既有） | 兜底拦截坏输出 |
| 输出修复 | 启发式 JSON 修复（缺逗号/尾随逗号） | 修复可自愈的语法错误 |
| 错误反馈重试 | 解析/校验失败时带错误反馈重试 1 次 | LLM 自行修正后重试 |
| 降级 | 仍失败则抛出友好错误 | 批量任务记录失败原因，不影响其它客户 |

本次按用户选择落地：P0 自动重试、P1 JSON 修复增强、P2 Prompt 防呆约束。

---

## 三、变更明细

### P0：自动重试（核心）— `llm-leaf.ts` + `types.ts`

- `GenerateParams` 新增 `retryFeedback?: string` 字段（types.ts），承载"上一轮输出未通过解析/结构校验时的错误反馈"，区别于合规重试的 `retryInstructions`
- `createLlmLeaf().generatePlans` 改为循环执行（最多 2 次调用）：
  - 每次独立临时 session，互不影响
  - 解析 → 程序回填 → 结构校验任一环节失败时，将错误消息经 `retryFeedback` 反馈给 LLM 重新生成
  - 反馈仅含错误消息（如"allocation 含未选产品名: P008"、"方案缺字段: title"），不含完整原始输出，避免上下文膨胀与信息泄露
- `buildPrompt` 增加"## 输出格式修正"段，注入 `retryFeedback`

### P1：启发式 JSON 修复 — `llm-leaf.ts`

- 新增 `repairMissingCommas()`：逐条正则修复缺逗号/尾随逗号
  - 删除尾随逗号（`,` 后紧跟 `}` / `]`）
  - `}` / `]` 值结束后紧跟 `{` / `[` / `"` 时补逗号
  - 字符串值结束后紧跟 `{` / `[` / `"` 时补逗号（键后跟 `:` 不受影响）
- 新增 `tryParseJson()`：先 `parseJsonWithRepair`，失败则叠加启发式修复再试
- **实现注意**：不做"数字/true/false/null 后补逗号"修复——正则无法区分字符串内外的数字（如 productId `"P001"` 内的 `1` 会被误伤为缺逗号），该场景极少见，即便发生也由 P0 重试兜底

### P2：Prompt 防呆约束 — `plan-generator/AGENTS.md`

- 新增"allocation 与选品一致性强约束"：
  - `allocation` 各类别 `products` 中的产品名称必须且只能来自本方案 `products` 所选 productId 对应的标准名称，禁止未选产品名/缩写/近似别名
  - `products` 中每个 productId 也必须在 `allocation` 中有对应配置

---

## 四、涉及文件清单

| 文件 | 变更 |
|---|---|
| `finclaw/pi-gateway/src/workflow/types.ts` | `GenerateParams` 新增 `retryFeedback` 字段 |
| `finclaw/pi-gateway/src/workflow/llm-leaf.ts` | 错误反馈重试循环；`repairMissingCommas` / `tryParseJson`；buildPrompt 注入格式修正段 |
| `finclaw/.pi/agents/plan-generator/AGENTS.md` | 新增 allocation 与选品一致性强约束 |
| `finclaw/pi-gateway/src/workflow/__tests__/llm-leaf-retry.test.ts` | 新增：P0 重试 4 例 + P1 修复 1 例 |
| `README.md` | 同步工程健壮性/方案生成工作原理/目录结构说明 |

---

## 五、验证结果

- pi-gateway 全量单测：**15 文件 / 122 用例全过**
- 新增 `llm-leaf-retry.test.ts` 覆盖：
  - 首次成功仅调用 1 次、无重试反馈
  - 缺字段校验失败 → 自动带错误反馈重试成功（断言第二次 prompt 含 `## 输出格式修正` 与具体错误）
  - allocation 一致性失败 → 重试成功
  - 两次均失败 → 抛出最后一次错误、共调用 2 次
  - 缺逗号 JSON 首轮即被启发式修复、无需重试

---

## 六、遗留与注意

1. **需重启生效**：pi-gateway 无热重载，改动后需重启服务
2. **温度递减未落地**：Pi SDK 的 `PromptOptions` / `createAgentSession` 未直接暴露 `temperature`，故本轮放弃温度调整，聚焦错误反馈重试；后续若 SDK 支持可叠加
3. **可扩展**：若仍频繁失败，可考虑引入完整 JSON 状态机修复器（如 jsonrepair）替代当前正则启发式，或增加单客户重试次数上限的配置
