# 2026-08-18 方案生成链路升级记录

本会话围绕「方案生成」完成了从**提示词增强 → 数据链路改造 → 前端适配 → Token 精简**的一整轮升级，并修复了过程中暴露的两个线上问题。文档按主题记录全部变更、涉及文件与验证结果。

---

## 一、目标与结果

| 目标 | 结果 |
|---|---|
| 方案生成内容"过于简单" | diagnosis 三段式诊断、products 字段补全、话术模板结构化、选品综合任务映射，生成质量显著提升 |
| context 超 4000 token 隐患 | 输出侧程序回填 + 输入侧表格化/截断/瘦身，CUST_001 context **2924 → 1924 token（-34%）**，预算回到 4000 |
| 前端方案/产品体验 | 方案详情诊断分段展示、产品 category 标签、产品详情弹窗（叠加层） |
| 线上问题 | 修复 snapshots.json 损坏（500）与 allocation 结构错误（详情打不开） |

---

## 二、变更明细

### 1. 修复类

**1.1 snapshots.json 数据损坏（选方案报 500）**
- 现象：点"选择方案"报 `Unexpected non-whitespace character after JSON at position 2351 (line 83 column 1)`
- 根因：`.runtime/data/snapshots.json` 合法数组后混入中文乱码（含非法 UTF-8 字节），`saveSnapshot → readJson → JSON.parse` 失败
- 处置：备份为 `snapshots.json.bak-2026-08-18T01-16-51-904Z`，截除乱码恢复合法 JSON（保留原有 1 条快照）
- 遗留：若再发，需给 `saveSnapshot` 加 promise 队列串行化（方案 B，未做）

**1.2 方案详情打不开（allocation 结构错误）**
- 现象：方案可生成，但点详情弹窗无响应
- 根因：LLM 输出 `{"现金管理类": 45, "pct": 55, "products": [...]}`（类别数字直赋、pct/products 平铺顶层），validatePlan 只校验 allocation 存在、不校验内部结构；前端 `allocation.products.join()` 抛 TypeError
- 修复：`validatePlan` 新增 allocation 结构校验（每类别值必须 `{ pct: number, products: string[] }`）；前端渲染防御；AGENTS.md 加结构强约束

### 2. profile 接口增强

- `store.mjs` 新增 `getLatestInsightForCustomer(customerId)`：按 createdAt 倒序取最新一条洞察
- `customers.routes.mjs` profile 接口：返回新增 `latestInsight` 字段；tasks 显式 map 保证每项带 `priority`（缺省兜底 0）
- `web/src/types.ts`：`CustomerProfile` 增加 `latestInsight?: Insight | null`

### 3. 方案生成 context 注入 strategies（客户任务）

- `types.ts`：`Strategy`（{id,priority,name,rule}）重定义为 `CustomerTask`（taskId/customerId/strategyType/strategyName/category/priority/triggerCondition/status/source/createdAt）；`WorkflowContext.strategies` 与 `LeafPlanContext.strategies` 同步
- `context-builder.ts`：`projectPlanContext` 投影时 strategies 非空原样透传
- `backend-client.ts`：fetchContext plan scope 并发从 4 个 GET 增至 **5 个**（新增 `GET /api/customers/{id}/tasks`，失败降级空数组），返回 `strategies: tasks`
- 测试同步：`context-builder.test.ts`、`backend-client-scope.test.ts`

### 4. 方案生成质量增强（grill-me 确认后实施）

**4.1 叶子提示词 `plan-generator/AGENTS.md` 重写**，新增/更新：
- **风险等级语义**：C1 保守型～C5 激进型、R1 低风险～R5 高风险，强制诊断/话术用中文语义
- **选品依据与任务映射表**：资产事件（除 account_review）+ 生命周期为选品依据、priority 作重要度权重、关系关怀仅用于话术；8 种 strategyType → 产品倾向映射
- **diagnosis 三段格式**：`【资产配置】… | 【风险诊断】… | 【任务诊断】…`（顺序固定、三段齐全）
- **reason 双角度生成**：产品字段总结 + 客户画像角度
- **话术模板**：wecom 6 段【标签】结构、phone 自然段落、关系关怀问候优先、权益白名单（仅 campaign/marketTags/personalKnowledge 已有权益可说）
- **allocation 结构强约束**（修复 1.2 的配套）

**4.2 代码侧**
- `types.ts`：`Product` 接口补齐 subCategory/description/benchmark/returns/marketTags/scriptTemplate/highlights；`LeafPlanContext.products` Pick 扩至 13 字段
- `context-builder.ts`：投影 6 → 13 字段
- `products.routes.mjs`：新增 **`GET /api/products/:id`**（全字段详情，404 兜底）
- `web/api.ts`：新增 `getProduct(productId)`
- `web/types.ts`：`MarketingPlan.products` 增加 `subCategory?/tenor?/expectedReturn?`

### 5. Token 精简 Phase1（A1+A3+B1+B2+B4）

| 方案 | 实现 |
|---|---|
| **A1 输出侧回填** | LLM 只输出 `productId + reason`，`backfillPlanFields()` 按 productId 从上下文回填 name/category/subCategory/riskLevel/tenor/expectedReturn；validatePlan 新增 reason 必填校验 |
| **A3 配置名称回填** | allocation.products 名称统一为回填后标准名称，未命中抛错 |
| **B1 输入表格化** | `serializeProductsTable()`：products 从嵌套 JSON 改扁平表格，表头声明字段顺序，键名只出现一次 |
| **B2 长文本截断** | description 截 80 字符、scriptTemplate 截 60 字符 |
| **B4 customer 瘦身** | 投影时剔除 `customer.tasks`（已由 strategies 承载） |

- `context-builder.ts`：`serializeLeafContext` 预算 **8000 → 4000**（表格化后 CUST_001 contextJson 实测 1924）
- AGENTS.md：输入说明改表格格式、products 字段表改"每项只输出 productId+reason"、示例精简

### 6. 前端适配

**6.1 方案详情弹窗**
- 诊断分析三段 → `.diagnosis-block` 次级标题（h5 左竖线），非三段格式自动降级
- 推荐产品 → 产品名下方 `.product-cat` category 标签，卡片可点击
- `render-utils.ts` 新增纯函数 `parseDiagnosisSections()`（正则提取【标签】段落，剔除段尾 ` | `）

**6.2 产品详情弹窗（叠加层）**
- 点击产品 → `openProductDetail()` 异步调 `getProduct` → `product-detail` 弹窗**叠加在方案弹窗之上**，关闭后恢复来源弹窗（`productDetailFrom` 记录）
- 展示字段：标签（类别/子类/风险等级/期限）、预期收益、产品描述、业绩基准、历史收益（近1月/近3月/近6月/近1年/今年）、产品亮点、市场标签、话术参考（`{{name}}` 占位符替换为当前客户名）
- 历史收益渲染修复：returns 为小数（0.02=0.20%），显示 `近1月 0.20%` 格式
- 移除"在售活动"展示

**6.3 样式**（styles.css）：.diagnosis-block / .product-cat / .plan-detail-product hover / .product-detail-modal / .returns-grid / .highlights-list；滚动规则扩展到 product-detail-modal

---

## 三、涉及文件清单

### 修改（13 个）

| 文件 | 变更 |
|---|---|
| `finclaw/.pi/agents/plan-generator/AGENTS.md` | 重写：风险语义/映射表/diagnosis 三段/话术模板/权益白名单/allocation 强约束/表格输入/精简输出 |
| `finclaw/backend/src/store.mjs` | 新增 getLatestInsightForCustomer |
| `finclaw/backend/src/routes/customers.routes.mjs` | profile 返回 latestInsight + tasks priority 兜底 |
| `finclaw/backend/src/routes/products.routes.mjs` | 新增 GET /api/products/:id |
| `finclaw/pi-gateway/src/workflow/types.ts` | CustomerTask；Product 扩展 7 字段；LeafPlanContext 13 字段 |
| `finclaw/pi-gateway/src/workflow/context-builder.ts` | strategies 透传；13 字段投影；表格化+截断；customer 剔 tasks；预算 4000 |
| `finclaw/pi-gateway/src/workflow/backend-client.ts` | fetchContext 5 个 GET（新增 tasks） |
| `finclaw/pi-gateway/src/workflow/llm-leaf.ts` | validatePlan（allocation/reason 校验）；backfillPlanFields；回填接入 |
| `finclaw/web/src/types.ts` | CustomerProfile.latestInsight；MarketingPlan.products 扩展 |
| `finclaw/web/src/api.ts` | 新增 getProduct |
| `finclaw/web/src/main.ts` | 诊断三段/产品标签/防御；产品详情弹窗+叠加；returns 修复；中文标签；{{name}} 替换 |
| `finclaw/web/src/render-utils.ts` | 新增 parseDiagnosisSections |
| `finclaw/web/src/styles.css` | 新增样式 + 滚动修复 |

### 新增（2 个）

| 文件 | 说明 |
|---|---|
| `finclaw/pi-gateway/src/workflow/__tests__/llm-leaf-validate.test.ts` | allocation 结构校验 5 例 + reason 校验 2 例 + backfill 回填 2 例 |
| `finclaw/web/src/render-utils.test.ts` | escapeHtml/money/parseDiagnosisSections 7 例 |

### 测试更新（2 个）

| 文件 | 变更 |
|---|---|
| `finclaw/pi-gateway/src/workflow/__tests__/context-builder.test.ts` | strategies 保留断言；13 字段断言；customer 剔 tasks；表格化断言；裁剪阈值校准（4000 预算） |
| `finclaw/pi-gateway/src/workflow/__tests__/backend-client-scope.test.ts` | plan scope 5 请求断言；strategies 有值 |

### 数据修复（1 个）

| 文件 | 说明 |
|---|---|
| `finclaw/.runtime/data/snapshots.json` | 截除乱码恢复合法 JSON（备份 .bak-2026-08-18T01-16-51-904Z） |

---

## 四、验证结果

| 套件 | 结果 |
|---|---|
| pi-gateway（vitest） | 12 文件 / **109 用例**全过 |
| web（vitest） | 6 文件 / **33 用例**全过 |
| backend（node --test） | 7/7 通过 |
| CUST_001 context | 19 产品表格化 + 2 任务，**1924 token**（预算 4000） |
| 前端构建 | vite build 通过（WorkBuddy 沙箱需 `--emptyOutDir false` 绕过 safe-delete 拦截） |

---

## 五、遗留事项与注意事项

1. **需重启生效**：pi-gateway、backend、web 均无热重载；gateway 在 WorkBuddy 会话内启动需带 `DEEPSEEK_API_KEY` 环境变量（沙箱 safe-delete 会拦截 auth.json.lock 释放）
2. **存量坏数据**：`plan_sessions.json` 中 3 套旧方案的 allocation 为错误结构（前端已防御不崩，配置比例显示为空），需重新生成覆盖
3. **Token 余量**：完整请求输入约 3700 / 4000，再新增提示词内容将顶破预算；后续可精简 AGENTS.md 示例或引入 Phase2
4. **Phase2/3 候选**：markdown 程序渲染（省输出 30-40%）、候选池粗筛（B3）、重试轮 diff 注入（C1）、snapshots 并发写加固
5. **环境已知问题**：WorkBuddy 沙箱 safe-delete 拦截 dist 清理与 auth.json.lock 释放；用户在正常终端用 `start.cmd` 无此问题
