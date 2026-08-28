# 知识沉淀与案例库 — 技术方案

> 版本：v2.1
> 最后更新：2026-08-14
> 参考 PRD：`knowledge-accumulation-prd.md`
> 说明：v2.1 依据项目架构审查结果校准文档，消除与代码现状不符的描述；同步已完成的 P0/P1 代码优化（类型统一、LLM 调用原子复用）。

---

## 1. 架构概览

### 1.1 整体架构

```
┌──────────────────────────────────────────────────────────────────────┐
│                           pi-gateway (18789)                           │
│                                                                      │
│  ┌──────────────────────────────┐     ┌────────────────────────────┐  │
│  │  AgentSession               │     │  Workflow Orchestrator      │  │
│  │  - 主对话 Agent             │     │  - 方案生成/优化            │  │
│  │  - 注册 save_knowledge 工具  │     │  - self-evolve（方案采纳后） │  │
│  └──────────────────────────────┘     └────────────────────────────┘  │
│           │                                │                           │
│           ▼                                ▼                           │
│  ┌─────────────────────────────────────────────────────────────────┐  │
│  │                   extractors.ts（提取模块）                       │  │
│  │                                                                  │  │
│  │  输入：{ 对话/方案, 客户画像, 现有知识库, 现有洞察 }              │  │
│  │  过程：构造 prompt → runLlmJson → 解析结果                        │  │
│  │  输出：{ content, tags, summary, confidence }                    │  │
│  │  特点：LLM 一次调用完成提取+去重，无需后端对比逻辑                │  │
│  └─────────────────────────────────────────────────────────────────┘  │
│           │                                                           │
│           ▼                                                           │
│  ┌─────────────────────────────────────────────────────────────────┐  │
│  │                   case-store.ts（案例库）                         │  │
│  │                                                                  │  │
│  │  - 内存 cosine 检索 + JSON 文件持久化                             │  │
│  │  - 结构化预过滤（risk/segment/aum） + 语义精排（embedding）       │  │
│  │  - 分层放宽兜底策略                                              │  │
│  └─────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  复用：runLlmJson（llm-json.ts）                                     │
│  复用：createBackendClient（backend-client.ts）                       │
│                                                                      │
└─────────────────────────────────┬─────────────────────────────────────┘
                                  │
┌─────────────────────────────────▼─────────────────────────────────────┐
│                          backend (3001)                                │
│                                                                       │
│  - 知识库：5 段结构，支持待确认区                                    │
│  - 洞察：批量确认/拒绝接口                                           │
│  - 案例库：CRUD 接口                                                  │
│  - 存储隔离：managerId 隔离                                           │
│                                                                       │
└─────────────────────────────────┬─────────────────────────────────────┘
                                  │
┌─────────────────────────────────▼─────────────────────────────────────┐
│                        DeepSeek LLM API                               │
│                                                                       │
│  - chat：知识提取（JSON 模式）                                         │
│  - embeddings：案例库向量生成（768 维）                                 │
│                                                                       │
└───────────────────────────────────────────────────────────────────────┘
```

### 1.2 核心设计决策

| 决策 | 结论 | 理由 |
|------|------|------|
| 触发时机 | 方案采纳 + 显式指令 | 信号明确，覆盖主要场景，复杂度低 |
| 提取执行者 | `runLlmJson` 直接调用 | 不需要 agent 能力，零状态污染，最轻量 |
| LLM 调用原子 | `runLlmJson` → `runLlmJsonOnce`（共享原子） | 已完成的 P1 优化：`llm-leaf` 与提取统一复用同一临时 session 流程 |
| 提取封装形式 | `extractors.ts` 可调用模块 | 两个入口复用同一模块，不污染 agent 上下文 |
| 去重方式 | LLM 调用时一次性完成 | 输入中包含现有知识库/洞察，语义去重优于字符串匹配 |
| 案例库检索 | 内存 cosine + JSON 文件 | 零新增依赖，案例量 < 1000 时 < 10ms |

---

## 2. 类型定义

### 2.1 知识提取

```typescript
// pi-gateway/src/workflow/extractors.ts

export type KnowledgeCategory =
  | "talkTemplates"      // 话术偏好 → 个人知识库
  | "productPriority"    // 产品推荐倾向 → 个人知识库
  | "stylePreference"    // 沟通风格 → 个人知识库
  | "combinationStrategy" // 组合策略经验 → 个人知识库
  | "compliance"         // 合规修正经验 → 个人知识库
  | "objectionHandling"  // 异议处理模式 → 个人知识库
  | "followUp"           // 跟进节奏偏好 → 个人知识库
  | "customerInsight"    // 客户洞察（隐性偏好/风险变化/生命周期/市场观点/客群经验）→ insights
  ;

export interface ExtractionRequest {
  category: KnowledgeCategory;
  // 提取源（二选一或同时提供）
  conversation?: string;        // 对话片段
  plan?: MarketingPlan;         // 被采纳的方案（方案采纳场景）
  // 客户画像（所有提取场景都需要）
  customer: CustomerProfile;
  // 去重参考（LLM 看到后天然跳过重复内容）
  existingKnowledge?: string;   // 现有知识库 Markdown 全文
  existingInsights?: Insight[]; // 现有洞察列表
  // 上下文
  managerId: string;
}

export interface ExtractionResult {
  content: string;           // 提取的知识文本
  tags: string[];            // 标签
  summary: string;           // 提取依据说明
  confidence: "high" | "medium" | "low";
  category: KnowledgeCategory;
  // 空结果标识（LLM 判断无新内容时返回空）
  isEmpty: boolean;
}
```

### 2.2 案例库

```typescript
// pi-gateway/src/workflow/case-store.ts

export interface CaseRecord {
  caseId: string;
  planId: string;
  customerId: string;
  managerId: string;

  // 结构化检索键
  segment: string;
  riskTolerance: string;
  lifeCycleStage: string;
  aumLevel: AumLevel;

  // 语义检索向量
  embedding: number[];

  // 注入 prompt 的摘要
  summary: {
    title: string;
    diagnosis: string;
    score: number;
    tags: string[];
    allocation: Record<string, { pct: number; products: string[] }>;
    products: Array<{ name: string; category: string; riskLevel: string; reason: string }>;
  };

  quality: "high" | "medium";
  createdAt: string;
}

export type AumLevel = "L1" | "L2" | "L3" | "L4" | "L5";
// L1: < 10万, L2: 10-50万, L3: 50-200万, L4: 200-1000万, L5: > 1000万

export interface CaseSearchResult {
  cases: CaseSummary[];
  totalFound: number;
  strategy: "full" | "relaxed-aum" | "relaxed-segment" | "risk-only" | "none";
}
```

### 2.3 WorkflowContext 扩展

```typescript
// pi-gateway/src/workflow/types.ts

export interface WorkflowContext {
  // ... existing fields
  customer: CustomerProfile;
  products: Product[];
  strategies: Strategy[];
  personalKnowledge: string;
  marketBrief?: string;
  similarCases?: CaseSummary[];  // ← 新增：检索到的相似案例
}
```

---

## 3. 提取模块（Extractors）实现

### 3.1 统一入口

```typescript
// pi-gateway/src/workflow/extractors.ts

export async function extractKnowledge(
  req: ExtractionRequest,
  piAgentDir: string,
): Promise<ExtractionResult> {
  // 1. 构造 prompt（含现有知识库/洞察，用于去重）
  const userPrompt = buildExtractionPrompt(req);

  // 2. 调用 LLM JSON 模式
  const systemPrompt = "你是银行客户经理的经验沉淀助手。只输出 JSON，不加解释或代码围栏。";
  const parsed = await runLlmJson(piAgentDir, systemPrompt, userPrompt);

  // 3. 解析结果
  const result = parseExtractionResult(parsed, req.category);
  return result;
}
```

### 3.2 Prompt 构造（通用模板）

所有提取 prompt 共享以下结构，核心差异在 `## 提取要求` 段：

```
你是银行客户经理的经验沉淀助手。只输出 JSON，不加解释或代码围栏。

## 客户画像
```json
{customerProfile}
```

## 提取源
<对话片段或方案详情>

## 现有知识库（供去重参考，避免重复提取）
```
{existingKnowledge}
```

## 现有洞察（供去重参考，避免重复提取）
```
{existingInsights}
```

## 提取要求
<各类提取项的具体要求>

## 输出要求
{ "content": "提取的知识文本（多条用换行分隔）", "tags": ["标签1"], "summary": "提取依据", "confidence": "high|medium|low" }
```

### 3.3 12 个提取项的 prompt 关键差异

| 提取项 | 提取源 | 去重参考 | 输出 content 要求 |
|--------|--------|----------|-------------------|
| talkTemplates | 对话/方案中的话术 | 知识库·话术模板段 | 可复用的沟通句式，直接可追加到知识库 |
| productPriority | 对话/方案中的产品选择 | 知识库·产品优先度段 | 推荐顺序与理由，品类搭配逻辑 |
| stylePreference | 对话/方案中的措辞 | 知识库·风格偏好段 | 语气正式/亲切、长短句偏好等 |
| combinationStrategy | 方案中的配置比例 | 知识库·产品优先度段 | 固收+现金打底等组合思路 |
| compliance | 方案中的合规处理 | 知识库·合规经验段 | 风险揭示语写法、违禁词规避 |
| objectionHandling | 对话中的异议讨论 | 知识库·话术模板段 | 应对客户拒绝理由的话术 |
| followUp | 对话中的跟进讨论 | 知识库·跟进策略段 | 触客频率、到期提醒时机 |
| customerInsight | 对话/方案中的客户特征 | 洞察列表 | 隐性偏好、风险变化、生命周期等 |

### 3.4 去重机制

**不在后端做去重。** 去重完全由 LLM 在提取时一次性完成：

```
输入：{ 对话, 客户画像, 现有知识库全文, 现有洞察列表 }
                        ↓
LLM 看到知识库中已有「客户偏好保守型配置」
   也看到对话中客户又说了一次「保守点好」
                        ↓
LLM 判断：这是重复信息，输出 { content: "", isEmpty: true }
```

**为什么 LLM 去重比后端去重好：**

| 场景 | 后端字符串匹配 | LLM 语义理解 |
|------|---------------|-------------|
| 已有：「客户偏好保守」→ 新：「客户不愿意承担风险」 | 匹配失败，视为两条 | 理解是同一回事，跳过 |
| 已有：「推荐固收+」→ 新：「建议配置 60% 固收理财」 | 匹配失败，视为两条 | 理解是同一策略，跳过 |
| 已有：「话术：您好我是XX」→ 新：「话术：XX经理您好」 | 匹配失败，视为两条 | 理解是不同话术，保留 |

### 3.5 空结果处理

当 LLM 判断无新内容时（`isEmpty: true`），提取结果不写入 backend，不产生待确认记录。调用方根据 `isEmpty` 判断是否需要继续处理。

---

## 4. 触发机制

### 4.1 触发点一：方案采纳（前端自动触发 + 扩展现有 suggest 通道）

**现状澄清（架构审查后校准）**：当前「方案采纳」与「知识沉淀建议」是**两个独立入口**：

- `confirmAdoptPlan`（[main.ts#L948](file:///d:/develop/finance_agent/finclaw/web/src/main.ts#L948)）：点击「采纳」只标记成交，**不触发任何提取**
- `suggestKnowledgeAction`（[main.ts#L896](file:///d:/develop/finance_agent/finclaw/web/src/main.ts#L896)）：知识库弹窗内手动按钮 → `POST /api/knowledge/suggest` → backend `forwardGateway` 转发 → pi-gateway 执行现有 `runSuggestKnowledge`

**新方案**：方案采纳时，前端 `confirmAdoptPlan` 末尾**自动触发**（不阻塞 UI），复用现有 suggest 通道。

**现有代码**：[self-evolve.ts#L75](file:///d:/develop/finance_agent/finclaw/pi-gateway/src/workflow/self-evolve.ts#L75) 的 `runSuggestKnowledge`，已通过 `runLlmJson`（[self-evolve.ts#L87](file:///d:/develop/finance_agent/finclaw/pi-gateway/src/workflow/self-evolve.ts#L87)）调用。

**改动**：扩展 `runSuggestKnowledge`，从当前 3 个提取项（话术/产品/风格）扩展为 6 项，并增加去重参数。

```typescript
// 修改后：self-evolve.ts
export async function runSuggestKnowledge(
  req: KnowledgeSuggestRequest,
  piAgentDir: string,
): Promise<KnowledgeSuggestion> {
  const backend = createBackendClient();
  const context = await backend.fetchContext(req.customerId, req.managerId);
  const { customer } = context;

  // 读取现有知识库（用于去重）
  const existingKnowledge = context.personalKnowledge;
  // 读取现有洞察（用于去重）
  const existingInsights = await backendReadInsights(req.customerId, req.managerId);

  // 并行执行 6 个提取项
  const results = await Promise.all([
    extractKnowledge({ category: "talkTemplates", plan: req.plan, customer, existingKnowledge, existingInsights, managerId: req.managerId }, piAgentDir),
    extractKnowledge({ category: "productPriority", plan: req.plan, customer, existingKnowledge, existingInsights, managerId: req.managerId }, piAgentDir),
    extractKnowledge({ category: "stylePreference", plan: req.plan, customer, existingKnowledge, existingInsights, managerId: req.managerId }, piAgentDir),
    extractKnowledge({ category: "combinationStrategy", plan: req.plan, customer, existingKnowledge, existingInsights, managerId: req.managerId }, piAgentDir),
    extractKnowledge({ category: "compliance", plan: req.plan, customer, existingKnowledge, existingInsights, managerId: req.managerId }, piAgentDir),
    extractKnowledge({ category: "objectionHandling", plan: req.plan, customer, existingKnowledge, existingInsights, managerId: req.managerId }, piAgentDir),
  ]);

  // 过滤空结果，写入待确认区
  return {
    talkTemplates: results.find(r => r.category === "talkTemplates" && !r.isEmpty)?.content ?? "",
    productPriority: results.find(r => r.category === "productPriority" && !r.isEmpty)?.content ?? "",
    stylePreference: results.find(r => r.category === "stylePreference" && !r.isEmpty)?.content ?? "",
    // 扩展字段（向后兼容，原 talkTemplates/productPriority/stylePreference 不变）
    extra: results.filter(r => !r.isEmpty && !["talkTemplates","productPriority","stylePreference"].includes(r.category)),
  };
}
```

**前端改动**：[main.ts#L948](file:///d:/develop/finance_agent/finclaw/web/src/main.ts#L948) 的 `confirmAdoptPlan` 末尾新增异步触发（失败不影响主流程）：

```typescript
private async confirmAdoptPlan(planId: string) {
  // ... 现有：标记成交 + persistSession + showToast
  this.suggestKnowledgeAction().catch(err =>
    console.warn("[extract] 方案采纳后提取失败（不影响主流程）:", err),
  );
}
```

### 4.2 触发点二：显式指令

**触发点**：经理在主对话中说「记住」「记下来」「记一下这个经验」。

**工具注册**：在 `agent-session.ts` 的 `createCustomTools()` 中注册 `save_knowledge` 工具。

#### 工具定义

```typescript
// pi-gateway/src/tools/save-knowledge.ts

const saveKnowledgeParams = Type.Object({
  content: Type.String({
    description: "经理要记住的知识内容，如「企业主客户更看重流动性」",
  }),
  category: Type.Optional(
    Type.String({
      description: "知识类别：talkTemplates/productPriority/stylePreference/compliance/followUp/customerInsight",
    }),
  ),
});

export function createSaveKnowledgeTool(): ToolDefinition {
  return {
    name: "save_knowledge",
    label: "记住知识",
    description:
      "记住客户经理要求沉淀的经验知识，存入个人知识库或客户洞察。当经理说「记住」「记下来」「记一下」时调用。",
    parameters: saveKnowledgeParams,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      // 1. 获取当前会话上下文
      const managerId = extractManagerId(ctx);
      const customerId = extractCustomerId(ctx);

      // 2. 读取现有知识库和洞察（用于去重）
      const backend = createBackendClient();
      const context = await backend.fetchContext(customerId, managerId);
      const existingInsights = await backendReadInsights(customerId, managerId);

      // 3. 调用提取模块（LLM 一次完成提取+去重）
      const result = await extractKnowledge({
        category: guessCategory(params.category, params.content),
        conversation: params.content,  // 显式指令：经理直接说的内容
        customer: context.customer,
        existingKnowledge: context.personalKnowledge,
        existingInsights,
        managerId,
      }, piAgentDir);

      // 4. 写入 backend
      if (!result.isEmpty) {
        if (result.category === "customerInsight") {
          await backendWriteInsight(customerId, {
            content: result.content,
            tags: result.tags,
            source: "llm",
          }, managerId);
        } else {
          // 合并到知识库
          await mergeIntoKnowledge(managerId, result);
        }
      }

      // 5. 返回给 Agent 的确认消息
      if (result.isEmpty) {
        return "该经验已存在于知识库中，无需重复记录。";
      }
      return `已记住：${result.summary}`;
    },
  };
}
```

#### 置信度策略

| 触发方式 | 置信度 | 写入方式 |
|----------|--------|----------|
| 显式指令 | `high` | 直接写入，无需确认 |
| 方案采纳 | `medium` | 写入待确认区，经理确认后生效 |

---

## 5. 案例库（CaseStore）实现

### 5.1 AUM 分桶

```typescript
function bucketAumLevel(aum: number): AumLevel {
  if (aum < 100_000) return "L1";      // < 10万
  if (aum < 500_000) return "L2";       // 10-50万
  if (aum < 2_000_000) return "L3";     // 50-200万
  if (aum < 10_000_000) return "L4";    // 200-1000万
  return "L5";                           // > 1000万
}
```

### 5.2 Embedding 生成

```typescript
async function getEmbedding(text: string): Promise<number[]> {
  if (DEEPSEEK_API_KEY) {
    try {
      const response = await fetch(`${DEEPSEEK_API_URL}/embeddings`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${DEEPSEEK_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "text-embedding-bge-large-en-v1.5",
          input: text,
        }),
      });
      if (response.ok) {
        const data = await response.json();
        const emb = data?.data?.[0]?.embedding;
        if (Array.isArray(emb)) return emb;
      }
    } catch {
      // 网络/服务异常时静默降级到本地向量
    }
  }
  return localEmbedding(text); // 本地确定性向量兜底
}
```

**本地确定性向量兜底**（`localEmbedding`）：DeepSeek API 不提供 embeddings 端点（404），实际运行时降级为本地向量化——将文本字符哈希累加映射到固定 64 维，相同文本 → 相同向量。检索退化为"返回结构化匹配的候选案例"而非语义检索，保证案例库有数据即可返回。

**客户画像向量化文本**（Phase 1：只按画像检索）：

```typescript
// case-store.ts

/**
 * 将客户画像转成向量化文本。
 * 只使用画像字段，不包含方案内容。
 * 选择 embedding 区分度高的字段：客群、风险等级、生命周期决定配置方向，
 * AUM 量级影响起购门槛和风险分散空间，偏好体现客户主观倾向。
 */
function buildCustomerVectorText(customer: CustomerProfile): string {
  const parts: string[] = [];

  // 客群：决定了推荐策略的大方向（退休→保守、企业主→流动性）
  if (customer.segment) {
    parts.push(`客群:${customer.segment}`);
  }

  // 风险等级：决定了可投产品池和配置比例上限（R1→纯固收、R5→可投权益）
  parts.push(`风险等级:${customer.riskTolerance}`);

  // 生命周期：影响资金用途和期限偏好（积累→长期、消耗→短期）
  if (customer.lifeCycleStage) {
    parts.push(`生命周期:${customer.lifeCycleStage}`);
  }

  // AUM：影响起购门槛和产品可选范围（L1→货基+理财、L4→可配私行/信托）
  parts.push(`AUM量级:${bucketAumLevel(customer.aum)}`);

  // 职业：补充客群判断（如"企业主"可能有对公联动需求）
  if (customer.occupation) {
    parts.push(`职业:${customer.occupation}`);
  }

  // 偏好：客户明确表达的主观倾向（如"偏好保本""关注ESG"）
  if (customer.preferences && customer.preferences.length > 0) {
    parts.push(`偏好:${customer.preferences.join("、")}`);
  }

  return parts.join(" | ");
}
```

**使用示例**：

```
输入 CustomerProfile：
  segment: "退休", riskTolerance: "R2", lifeCycleStage: "消耗",
  aum: 800000, occupation: "退休教师", preferences: ["保本", "短期"]

输出向量化文本：
  客群:退休 | 风险等级:R2 | 生命周期:消耗 | AUM量级:L3 | 职业:退休教师 | 偏好:保本、短期
```

### 5.3 余弦相似度

```typescript
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return Math.sqrt(normA) * Math.sqrt(normB) === 0 ? 0 : dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
```

### 5.4 检索策略（分层放宽）

```
所有案例（按 managerId 过滤）
    │
    ├─ riskTolerance + segment + aumLevel 全匹配 → 候选集
    │     │
    │     └─ 候选 ≥ 3 个 → 余弦排序取 Top-3 → strategy: "full"
    │
    └─ 候选 < 3 个 → 放宽 aumLevel 约束
          │
          ├─ 候选 ≥ 3 个 → 余弦排序取 Top-3 → strategy: "relaxed-aum"
          │
          └─ 候选 < 3 个 → 继续放宽 segment ……
```

**相似度阈值过滤与兜底**：余弦相似度低于 0.5 的候选会被过滤；若过滤后结果为空，则兜底返回结构化匹配的候选（按相似度降序取 Top-K），避免案例库有数据却检索为空。

### 5.5 入库时机

**触发条件**：方案被采纳（`adoptedPlanId`）且 `score >= 7`。

**入库位置**：`self-evolve.ts` 中，在提取洞察之后，写入案例库。

```typescript
// 方案采纳后，在 self-evolve.ts 中
if (plan.score >= 7) {
  await caseStore.add({
    planId: plan.planId,
    customerId: req.customerId,
    managerId: req.managerId,
    segment: customer.segment,
    riskTolerance: customer.riskTolerance,
    lifeCycleStage: customer.lifeCycleStage,
    aumLevel: bucketAumLevel(customer.aum),
    embedding: await getEmbedding(buildCustomerVectorText(customer)),
    // buildCustomerVectorText 只使用画像字段：客群/风险等级/生命周期/AUM量级/职业/偏好
    summary: {
      title: plan.title,
      diagnosis: plan.diagnosis,
      score: plan.score,
      tags: plan.tags,
      allocation: plan.allocation,
      products: plan.products.map(p => ({
        name: p.name, category: p.category,
        riskLevel: p.riskLevel, reason: p.reason,
      })),
    },
    quality: plan.score >= 9 ? "high" : "medium",
  });
}
```

### 5.6 检索时机与注入

在 `backend-client.ts` 的 `fetchContext` 末尾增加：

```typescript
async fetchContext(customerId, managerId) {
  // 现有 4 个并发请求
  const [customer, products, strategies, knowledge] = await Promise.all([...]);

  // 新增：检索相似案例
  const similarCases = await caseStore.search(customer, managerId, 3);

  return { customer, products, strategies, personalKnowledge, marketBrief: "", similarCases };
}
```

### 5.7 Prompt 注入

在 `llm-leaf.ts` 的 `buildPrompt` 中，`## 业务上下文` 之后、`## 输出要求` 之前新增：

```
## 参考案例（相似客户的成功方案，供参考借鉴）

### 案例 1：退休客户稳健配置方案 · 9 分
诊断：客户张明远，退休阶段，R2 风险等级，AUM 80 万，偏好固收类产品
配置比例：
- 固收理财: 50% → 产品A、产品B
- 现金管理: 30% → 产品C
- 保险: 20% → 产品D
推荐产品：
- **产品A**（固收理财）：稳健增值，匹配退休需求
- **产品C**（现金管理）：流动性好，应对日常支出

### 案例 2：...
```

### 5.8 持久化

- **存储路径**：`finclaw/.runtime/data/case-store.json`
- **加载时机**：`CaseStore` 构造函数调用 `load()`，在 pi-gateway 启动时加载
- **保存时机**：`add()` / `delete()` 后异步调用 `save()`
- **GC 策略**：每经理上限 1000 条，超过时淘汰 `quality: medium` 且最早入库的 20%

---

## 6. 后端 API 扩展

### 6.1 知识库结构扩展

当前知识库存储格式（Markdown，5 段）：

```markdown
### 话术模板

...内容...

### 产品优先度

...内容...

### 风格偏好

...内容...

### 合规经验

...内容...

### 跟进策略

...内容...
```

### 6.2 新增接口

| 接口 | 方法 | 说明 |
|------|------|------|
| `GET /api/knowledge/pending` | GET | 获取待确认知识列表 |
| `POST /api/knowledge/confirm-pending` | POST | 批量确认待确认知识 |
| `POST /api/knowledge/reject-pending` | POST | 批量拒绝待确认知识 |
| `GET /api/case-store` | GET | 获取当前经理案例列表 |
| `DELETE /api/case-store/:caseId` | DELETE | 删除案例 |

### 6.3 存储路径

- 案例库：`finclaw/.runtime/data/case-store.json`
- 待确认知识：`finclaw/.runtime/data/pending-knowledge.json`（新增）

> **与现有代码一致**：backend [store.mjs#L9](file:///d:/develop/finance_agent/finclaw/backend/src/store.mjs#L9) 的 runtime 目录为 `path.resolve(sourceDir, "../../.runtime/data")`（即 `finclaw/.runtime/data`），并支持 `FINANCE_RUNTIME_DIR` 环境变量覆盖。案例库/待确认知识的存储应复用同一 runtime 目录，避免数据分裂。

---

## 7. 文件变更清单

### 7.1 新增文件

| 路径 | 说明 |
|------|------|
| `pi-gateway/src/workflow/extractors.ts` | 提取模块：12 个提取 prompt 函数 + 统一入口 |
| `pi-gateway/src/workflow/case-store.ts` | 案例库：存储/检索/GC |
| `pi-gateway/src/tools/save-knowledge.ts` | 显式指令工具定义 |

### 7.2 修改文件

| 路径 | 改动 |
|------|------|
| `pi-gateway/src/workflow/types.ts` | `WorkflowContext` 增加 `similarCases`；`CustomerProfile` 已补 `birthday/tasks/tags`（P0 已完成） |
| `pi-gateway/src/workflow/backend-client.ts` | `fetchContext` 增加案例检索调用 |
| `pi-gateway/src/workflow/llm-leaf.ts` | `buildPrompt` 增加「参考案例」段注入；已复用 `runLlmJsonOnce`（P1 已完成） |
| `pi-gateway/src/workflow/self-evolve.ts` | `runSuggestKnowledge` 扩展为 6 项提取 + 案例入库 |
| `pi-gateway/src/agent-session.ts` | 注册 `save_knowledge` 工具 |
| `pi-gateway/src/tools/customer-analyze.ts` | 在 `createCustomTools()` 中追加 `save_knowledge` 工具（**项目无 `tools/index.ts`，工具注册统一在此文件**）；已复用 `workflow/types.ts` 类型（P0 已完成） |
| `web/src/main.ts` | `confirmAdoptPlan` 末尾自动触发知识提取（不阻塞 UI） |
| `backend/src/routes/knowledge.routes.mjs` | 新增待确认列表、批量确认/拒绝接口 |
| `backend/src/routes/case-store.routes.mjs` | 新增案例列表、删除接口 |
| `backend/src/server.mjs` | 注册新路由 |
| `backend/src/store.mjs` | 增加 `pending-knowledge.json` 存取 |

### 7.3 已完成的现状优化（P0/P1，本分支已提交）

架构审查后已完成两项与知识沉淀无直接冲突的解耦优化，后续实现本方案时**不得回退**：

| 提交 | 内容 |
|------|------|
| `CustomerProfile`/`Product` 类型统一 | 删除 `tools/customer-analyze.ts` 中的重复定义，改为 `import` `workflow/types.ts`；`types.ts` 补齐 `birthday/tasks/tags` 字段 |
| `llm-leaf` 复用 `runLlmJsonOnce` | `generatePlans` 不再重复建 session，改调 `llm-json.ts` 的共享原子（约 40 行重复消除）；`runLlmJsonOnce` 新增可选 `sessionsRoot` 参数保持兼容 |

> 新提取模块 `extractors.ts` 应直接复用 `runLlmJson`（内部即 `runLlmJsonOnce`），与现有 `self-evolve.ts` 保持一致，不要另起一套 session 管理。

---

## 8. 测试策略

### 8.1 单元测试

| 文件 | 测试点 |
|------|--------|
| `extractors.test.ts` | prompt 构造正确、输出解析、空结果处理 |
| `case-store.test.ts` | 分桶、过滤策略、余弦相似度、GC、去重入库 |

### 8.2 集成测试

- 模拟方案采纳 → 验证提取模块被调用 → 验证结果写入待确认区
- 模拟显式指令 → 验证 `save_knowledge` 工具被调用 → 验证结果直接写入
- 模拟案例入库 → 验证检索时返回相似案例

### 8.3 向后兼容

- `similarCases` 是可选字段，缺省为 `undefined`，不影响现有流程
- `runSuggestKnowledge` 返回字段扩展，原有 `talkTemplates/productPriority/stylePreference` 不变
- 知识库现有 3 段结构保留，新增段不影响解析

---

## 9. 性能与成本

| 操作 | 耗时 | 成本 |
|------|------|------|
| 案例入库（embedding API） | ~200ms | ~0.001 元 |
| 案例检索（内存 cosine） | < 10ms | 0 元 |
| 知识提取（单次 LLM） | ~1-2s | ~0.001-0.005 元 |
| 方案采纳 6 项提取 | ~6-12s（并行） | ~0.006-0.03 元 |

内存占用：1000 条案例 × 768 维 embedding × 4 字节 ≈ **3 MB**。

---

## 10. 风险应对

| 风险 | 应对 |
|------|------|
| DeepSeek embedding API 不可用 | 不注入案例，流程退化为原有行为，不阻断方案生成 |
| 提取结果噪声多 | 方案采纳结果进入待确认区，经理确认后才生效；显式指令置信度高，直接写入 |
| 案例库全是不相关结果 | 兜底策略：全约束无匹配则逐级放宽，仍无则不注入 |
| 存储文件变大 | 每条案例几百字节，1000 条约几百 KB，JSON 读写无压力 |