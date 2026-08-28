# 记忆系统与上下文管理设计

> 本设计面向智能财富顾问（finance_agent）的 pi-gateway / backend 两层，定义一套统一的「记忆 + 上下文」体系：记忆负责持久化与回流，上下文负责按指令组装并发送给模型。所有指令链路（主对话、方案生成、方案优化、洞察、提取沉淀、知识建议）共用同一套机制。

## 1. 设计目标

- **记忆与上下文解耦**：记忆是持久化的唯一事实源，上下文是每次请求从记忆投影出来的瞬态窗口。
- **单一出口**：记忆读写收敛到 `MemoryStore`，上下文组装收敛到 `ContextBuilder`，杜绝各调用点各自取数、各自序列化。
- **按需取用**：每条指令只取它真正需要的记忆子集，只投影它真正用到的字段。
- **缓存友好**：上下文按「稳定前缀 + 动态尾巴」组织，最大化 DeepSeek 前缀缓存命中，压缩成本。
- **长期可用**：会话无限增长时由 Pi SDK compaction 压缩兜底，避免超窗与上下文腐化。
- **可观测**：每次组装记录 token 计数（含命中/未命中），支持成本与质量运营。

## 2. 总体架构

```
┌─────────────────────────────────────────────────────────────┐
│  L2 即时上下文（请求级 · 瞬态投影）                            │
│  主对话窗口 │ 方案叶子窗口 │ 洞察窗口 │ 提取窗口 │ 知识窗口       │
└──────────────────────────▲──────────────────────────────────┘
                           │ 投影注入（toLeafContext + 序列化）
┌──────────────────────────┴──────────────────────────────────┐
│  ContextBuilder · 上下文组装层（单一出口）                      │
│  resolveScope → fetch → project → serialize                  │
└──────────────────────────▲──────────────────────────────────┘
                           │ 按需读取
┌──────────────────────────┴──────────────────────────────────┐
│  L1 会话记忆（单会话多轮 · 持久化 .pi/sessions/*.jsonl）         │
│  Pi SDK AgentSession 历史（SDK 管写 · 网关管读）                │
└──────────────────────────▲──────────────────────────────────┘
                           │ 会话生命周期内复用
┌──────────────────────────┴──────────────────────────────────┐
│  L0 长期记忆（跨会话 · backend .runtime/data + 新增）           │
│  客户画像 │ 洞察 │ 客户级会话摘要 │ 个人知识库 │ 方案会话 │ 快照 │ 任务 │
└─────────────────────────────────────────────────────────────┘
   回写通道：方案接受→洞察提取+知识库建议 · 洞察确认→画像tags · 会话结束→摘要刷新
```

三层记忆与一层组装：

| 层 | 是什么 | 生命周期 | 存储 |
|---|---|---|---|
| L0 长期记忆 | 客户画像、洞察、知识库、方案会话、快照、任务、**客户级会话摘要** | 跨会话 | backend `.runtime/data/*.json` |
| L1 会话记忆 | 主对话多轮历史 | 单会话（持久化） | `.pi/sessions/{safeKey}/*.jsonl`（SDK 写入） |
| L2 即时上下文 | 每次请求组装后发送给模型的内容 | 请求级（瞬态） | 无，内存组装 |

## 3. 记忆系统设计

### 3.1 记忆实体与存储

| 记忆实体 | 存储文件 | 归属 | 写入通道 | 读取通道 |
|---|---|---|---|---|
| 客户画像 | seed + 运行时（store.mjs 管理） | 客户 | 外部/人工维护 | `GET /profile` |
| 客户任务 | `customer_tasks.json` | 客户 | 规则层 `evaluateCustomers` | `GET /tasks` |
| 洞察 | `insights.json` | 客户 | 批量洞察 LLM + 方案接受 LLM 提取 | `GET /insights` |
| 客户级会话摘要（新增） | `customer_summaries.json` | 客户 | 会话结束后 LLM 提炼 | ContextBuilder chat scope |
| 个人知识库 | `knowledge.json` | 经理 | 手动 + 方案接受后 LLM 建议→经理确认 | `GET /knowledge` |
| 方案会话 | `plan_sessions.json` | 客户+经理 | 前端 persistSession | `GET /sessions/:id` |
| 方案快照 | `snapshots.json` | 方案 | saveSnapshot（按 planId 幂等） | 前端对比 |
| 主对话历史 | `.pi/sessions/*.jsonl` | 会话 | Pi SDK SessionManager | `listSessions` / `getSessionMessages` |

### 3.2 MemoryStore 统一读写接口

记忆读写全部收敛到统一接口（backend 侧封装现有 store.mjs 的文件读写，为后续迁移数据库预留）：

```ts
interface MemoryStore {
  // 客户记忆
  getCustomerProfile(customerId: string): Promise<CustomerProfile>;
  getCustomerTasks(customerId: string): Promise<MarketingTask[]>;
  getCustomerInsights(customerId: string, status?: InsightStatus): Promise<Insight[]>;
  getCustomerSummary(customerId: string): Promise<CustomerSummary | null>;
  saveCustomerSummary(summary: CustomerSummary): Promise<void>;
  // 经理记忆
  getKnowledge(managerId: string): Promise<string>;
  saveKnowledgeSuggestion(managerId: string, suggestion: KnowledgeSuggestion): Promise<void>;
  // 方案记忆
  getPlanSession(sessionId: string): Promise<PlanSession | null>;
  saveSnapshot(planId: string, snapshot: Snapshot): Promise<void>;
}
```

写入侧同时保留现有回调链路（`addInsight`、`confirmInsight`、`updatePlanSession`、`saveKnowledge`），统一由 `MemoryStore` 暴露。

### 3.3 客户级会话摘要（新增记忆）

解决「主对话每轮业务上下文真空、跨会话失忆」的核心记忆组件。

**数据结构**：

```ts
interface CustomerSummary {
  customerId: string;
  updatedAt: string;
  preferences: string[];      // 沟通与产品偏好
  adoptedPlans: string[];     // 已采用方案 planId（轻量引用）
  concerns: string[];         // 客户关注点/风险顾虑
  opportunities: string[];    // 到期承接等下一步机会
  raw: string;                // 精简正文（注入用，目标 ≤ 200 token）
}
```

**生成时机**：会话结束（或每会话定期，由配置决定）时，用 [llm-json.ts](../../finclaw/pi-gateway/src/workflow/llm-json.ts) 的一次性原子调用，从该会话的主对话历史 + 方案结果提炼，幂等覆盖写入 `customer_summaries.json`。

**注入时机**：主对话每次请求组装 chat scope 时注入（见 4.3）。会话切换/新会话首次请求时同样注入，实现跨会话记忆延续。

**更新策略**：新摘要覆盖旧摘要（保留最近状态），避免无限累积。

### 3.4 记忆写入与回流通道

- **方案接受 → 洞察**：经理标记成交（adoptedPlanId）后，触发 LLM 提取 1 条 `source=accepted` 洞察，进入 pending 待确认区。
- **洞察确认 → 画像**：洞察 `status=confirmed` 后，其 tags 回写客户画像（tags 合并，冲突以最新确认时间为准）。
- **方案接受 → 知识库建议**：经理确认成交后，LLM 生成知识库更新建议（话术模板/产品优先度/风格偏好），进入待确认区，经理确认后写入 `knowledge.json`。
- **会话结束 → 客户摘要**：见 3.3。
- **快照**：`saveSnapshot` 按 planId 幂等写入（旧快照被覆盖），供前端对比。

### 3.5 记忆时效与去重

- **洞察**：状态机 `pending → confirmed | rejected`；批量洞察仅处理画像哈希有变化的客户（`customer_profile_hashes.json`），避免重复洞察。
- **画像 tags**：来自洞察确认的 tags 带 `confirmedAt`，新确认覆盖旧值；与画像原文冲突时以 tags 为准（tags 是更新时点）。
- **知识库**：建议需经理确认才写入；提供定期归档/清理（保留最近 N 个版本，超出的进入归档区），防止无限累积与过时。

## 4. 上下文组装（ContextBuilder）

### 4.1 四步组装流程

所有指令链路统一走 `ContextBuilder` 组装：

```ts
interface ContextBuilder {
  resolveScope(kind: InstructionKind): Scope;   // ① 判定指令类型 → 取用范围
  fetch(scope: Scope, ids: ScopeIds): Promise<Partial<WorkflowContext>>; // ② 按 scope 只取所需记忆
  project(input: Partial<WorkflowContext>): LeafContext; // ③ 字段白名单投影
  serialize(leaf: LeafContext): string;        // ④ 紧凑 JSON + 预算 + 缓存布局
}
```

- **resolveScope**：判定当前指令属于哪种链路，决定取哪些记忆（对应 `fetch` 的请求子集）。
- **fetch**：按 scope 并发拉取；不同 scope 拉不同接口，不再每次全量 4 并发。
- **project**：`toLeafContext` 白名单裁剪，产出模型真正需要的字段。
- **serialize**：紧凑 JSON 序列化 + token 预算控制 + 稳定前缀/动态尾巴布局。

### 4.2 指令 scope 映射

| 指令链路 | kind | fetch 的记忆 | 使用方 |
|---|---|---|---|
| 主对话（自由咨询） | `chat` | 客户摘要 + 知识库精简 | agent-session.ts |
| 方案生成 / 优化 | `plan` | 画像 + 适配产品 + 知识库 + 市场简报 | orchestrator.ts / llm-leaf.ts |
| 洞察批量生成 | `insight` | 客户画像子集 + 任务 | insight-batch.ts |
| 洞察提取（方案接受） | `extract` | 客户画像 + 方案摘要 | self-evolve.ts |
| 知识库建议 | `knowledge` | 客户画像 + 方案摘要 | self-evolve.ts |

`chat` 与 `plan` 是两个最主要的 scope，其余 scope 均只取 customer 子集，避免拉取无关记忆。

### 4.3 字段投影规约（toLeafContext 白名单）

各 scope 的投影输出（白名单，未列出的字段一律不注入）：

**chat scope（主对话稳定前缀）**

```ts
{
  customer: pick(profile, ["id", "name", "segment", "riskLevel", "aum", "maturity", "preferences"]),
  summary: CustomerSummary.raw,        // 客户级会话摘要 ≈200 token
  knowledge: firstNChars(knowledge, 300),  // 知识库精简
}
```

**plan scope（方案叶子）**

```ts
{
  customer: CustomerProfile,              // 画像全量（方案必需）
  products: products.map(pick, ["productId", "name", "category", "riskLevel", "expectedReturn", "tenor", "currency"]), // 截断大字段（campaign/配额等）
  personalKnowledge: knowledge,
  marketBrief?: string,                   // 有则经白名单保留在紧凑 JSON 内一并注入（不另起独立段）
  // strategies 不注入：方案引擎不依赖策略文本，避免冗余
}
```

**insight / extract / knowledge scope**：`customer` 子集（id/name/segment/riskLevel/aum/maturity/preferences）+ 各自的少量补充字段。

### 4.4 序列化与预算

- **紧凑序列化**：JSON 使用无缩进紧凑格式（替换现有 `JSON.stringify(ctx, null, 2)` 全量注入），保留可读节标题。
- **token 预算**：每 scope 设预算常量（可配置），组装前按比例分配；超预算时按「检索/工具返回 → 历史 → 摘要」顺序裁减，最后保留系统指令与当前消息。

| scope | 预算参考 | 预留输出 |
|---|---|---|
| chat | 客户摘要 ≤ 400 + 知识库 ≤ 300（会话历史由 SDK 回放与压缩管理） | 足够回答余量 |
| plan | 画像 + 产品截断 + 知识库 + 市场简报 ≤ 4000 | 3 套方案 JSON |
| insight / extract / knowledge | ≤ 1500 | 单条结构化输出 |

- **缓存友好布局**：主对话把「客户摘要 + 知识库 + 系统指令」作为稳定前缀（跨请求不变，命中 DeepSeek 前缀缓存），把「本轮消息」作为动态尾巴；`customer_id / manager_id` 等标识从消息前缀移入稳定前缀，避免污染动态段。

### 4.5 工具结果回灌规约

- **方案结果**：工具回灌到主对话的文本只含轻量 `[planId] 标题 评分` 引用；完整方案经 `details.result` 透传前端，模型按需调 `get_plan(plan_id)` 取用（保持现有设计）。
- **产品查询**：回灌文本只含 `name/category/riskLevel/expectedReturn/tenor` 等必要字段，超长结果分页或摘要，避免逐轮累积大段 JSON。
- **客户分析**：回灌为结构化文本摘要，不含内部原始 JSON。

## 5. 各指令链路上下文组装

### 5.1 主对话链路（chat）

1. ContextBuilder 组装 `chat` scope 稳定前缀（客户摘要 + 知识库精简）。
2. `runPrompt` 以「稳定前缀 + 本轮消息」调用 Pi SDK（替换现有每轮拼 `[会话上下文]` 消息前缀的方式，改为会话级稳定注入）。
3. Pi SDK 回放 L1 历史 + 前缀 + 消息 → 模型；模型在 ReAct 循环中自主决定是否调自定义工具。
4. 工具返回按 4.5 轻量回灌，继续循环直至最终回答。

### 5.2 方案生成 / 优化链路（plan）

1. `generate_plan` / `optimize_plan` 工具触发 `orchestrator.runGeneratePlan / runOptimizePlan`。
2. ContextBuilder 组装 `plan` scope（画像 + 适配产品 + 知识库 + 市场简报，白名单剔除 strategies）。
3. 前置风控闸门（确定性规则）→ LLM 叶子单次生成（紧凑序列化 + 预算）→ 合规审查 → 有界重试 ≤3 轮。
4. 结果 `{ plans, complianceReport }` 返回工具层，轻量摘要回灌主对话，完整方案经 details 透传前端。

### 5.3 洞察 / 提取 / 知识建议链路

1. 批量洞察：按客户 hash 变化过滤 → `insight` scope 组装 → LLM 生成 → 写入 pending。
2. 方案接受提取：`extract` scope → LLM 提取 1 条洞察 → pending。
3. 知识库建议：`knowledge` scope → LLM 建议 → 待确认区。
4. 确认后的洞察 tags 回写画像，建议确认后写入知识库。

## 6. 一次典型请求的完整流程

以经理输入「帮客户 A 生成一份稳健型理财方案」为例：

1. 前端 `sendMessage` → `POST /api/agent/run`，body 仅含 `{ sessionKey, message, customer_id, manager_id }`（业务数据不随请求传输）。
2. 主对话 ReAct 层：ContextBuilder 组装 chat 稳定前缀（客户摘要 + 知识库）→ Pi SDK 回放历史 + 前缀 + 消息 → 模型自主决策调用 `generate_plan`。
3. `generate_plan` 工具 → orchestrator：ContextBuilder 组装 plan scope（画像 + 适配产品 + 知识库 + 市场简报）→ 风控闸门 → 叶子生成 → 合规审查 → 有界重试。
4. 结果回灌：摘要 `[planId]` 回主对话，完整方案经 details 透传前端；主对话继续 → SSE 流式返回（thinking / tool_call / message / final）。
5. 前端持久化 PlanSession + 快照（幂等）；经理标记成交时触发洞察提取 + 知识库建议；会话结束刷新客户摘要。

## 7. 会话长期管理

- **SDK 原生压缩（主方案）**：启用 Pi SDK 内置 `compaction`（`.pi/settings.json` 中 `compaction.enabled: true`），由 SDK 按 Token 阈值自动触发：当 `contextTokens > contextWindow - reserveTokens` 时，将 `keepRecentTokens` 之前的消息压缩为结构化摘要，替换发送给模型的旧历史。阈值均可配置（`reserveTokens` 默认 16384、`keepRecentTokens` 默认 20000），SDK 负责持久化原文，压缩摘要作为 `CompactionEntry` 追加进会话，回放时「摘要 + firstKeptEntryId 起原文」一并发送。
- **手动触发与领域规则**：需要时在网关调用 `session.compact(customInstructions?)` 手动压缩，通过 `customInstructions` 注入领域规则（如「保留客户风险偏好、已采用方案 planId 与待办事项」），引导摘要聚焦业务关键信息；订阅 `compaction_start / compaction_end` 事件（`reason: manual | threshold | overflow`）感知压缩状态。若默认摘要格式（Goal/Progress/Key Decisions 等）不满足业务要求，可注册 `session_before_compact` 扩展钩子注入自定义摘要。
- **与客户级会话摘要的关系**：SDK 压缩聚焦「单会话内对话历史的形式压缩」，客户级会话摘要（3.3）聚焦「跨会话业务语义提炼」，两者互补：SDK 压缩保证长会话不超窗，客户摘要保证新会话不丢业务上下文。
- **工具结果**：按 4.5 白名单截断，历史中不残留大段工具 JSON，压缩与回放都更轻量。

## 8. 落地映射与验证

### 阶段一 · 收口与瘦身（低风险）

| 改动 | 代码落点 |
|---|---|
| 新建 `pi-gateway/src/workflow/context-builder.ts`（resolveScope / fetch / project / serialize） | 新文件 |
| `fetchContext` 支持 `scope` 参数（full / customer 等） | backend-client.ts |
| 叶子 prompt 改走 toLeafContext 投影 + 紧凑序列化 | llm-leaf.ts `buildPrompt` |
| 合并 backend HTTP 基建（backend-client / backend-http 共用 loadConfig/buildHeaders） | backend-client.ts / backend-http.ts |

**验证**：`pnpm --filter pi-gateway test`、`tsc --noEmit`、`vite build`；各链路跑通。

### 阶段二 · 记忆补齐与回流

| 改动 | 代码落点 |
|---|---|
| 新增 `customer_summaries.json` + MemoryStore 读写 | backend store.mjs |
| 客户级会话摘要生成（会话结束提炼） | pi-gateway workflow（复用 llm-json.ts） |
| 主对话稳定前缀注入（摘要 + 知识库），替换逐轮 `[会话上下文]` 前缀 | agent-session.ts `runPrompt` |
| 接通市场简报数据源 | backend `/api/market/brief` 或 `market_query` 工具 |

**验证**：切换客户会话注入摘要；重启网关后摘要与历史均可恢复；`pnpm test`。

### 阶段三 · 长会话与缓存

| 改动 | 代码落点 |
|---|---|
| 启用 SDK compaction（settings 配置 + compact 调用 + 事件订阅） | agent-session.ts / .pi/settings.json |
| 工具结果字段白名单截断 | 各工具 content 生成处 |
| token 计数与缓存命中日志（prompt_cache_hit/miss_tokens） | context-builder serialize |

**验证**：长会话 token 曲线收敛；日志可观测缓存命中率。
