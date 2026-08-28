# 知识沉淀与案例库 PRD

> 版本：v2.1
> 状态：待审阅
> 配套参考：`knowledge-accumulation-tech.md`、`api-reference.md`
> 说明：v2.1 依据项目架构审查结果校准文档（触发链路、文件清单），并同步已完成的 P0/P1 代码优化。

---

## 1. 产品背景与定位

### 1.1 当前问题

系统已有方案生成、合规审查、方案采纳等核心能力，但在**知识沉淀**方面存在明显缺口：

1. **方案生成无经验复用**：每次调用 LLM 从零生成，已采纳的优秀方案未被回流入 prompt 作为参考，方案质量上限被模型能力锁定，不随使用积累而提升
2. **对话隐性知识流失**：客户经理与 AI 对话中产生的客户偏好、市场判断、策略经验等，未被系统捕获，大量隐性知识「说了就过」
3. **个人知识库粗粒度**：知识库仅 3 段 Markdown 文本（话术/产品/风格），直接整体拼接注入，无法按客户特征精准匹配
4. **合规重试成本高**：初次生成常因违禁词、风险等级不匹配被拦截，缺少成功案例作为 few-shot 参考

### 1.2 核心价值主张

- **对话即沉淀**：客户经理与 AI 对话过程中的可复用经验，被自动或半自动捕获，形成个人知识资产
- **案例反哺质量**：被采纳的优秀方案回流到生成环节，使方案质量随使用次数持续提升
- **经理个人适配**：知识库从「三段固定模板」进化为「多维度、可检索、可自动扩展」的个性化知识体系

---

## 2. 用户故事

### 2.1 知识提取

| ID | 用户故事 | 优先级 |
|----|---------|--------|
| KE-01 | 作为客户经理，我希望在对话中告诉 AI「记住这个经验」，AI 能立即记下来并应用到后续对话，这样我不用重复说同样的话 | P0 |
| KE-02 | 作为客户经理，当我采纳一个方案后，我希望系统自动从方案中提取可复用的经验和偏好，更新到我的知识库（待确认后生效） | P0 |
| KE-03 | 作为客户经理，我希望知识库的内容不是无限制增长的，而是能合并、去重、确认后才生效，避免垃圾信息堆积 | P1 |

### 2.2 案例库

| ID | 用户故事 | 优先级 |
|----|---------|--------|
| CL-01 | 作为客户经理，我希望系统为我生成方案时能参考相似客户的成功案例，这样方案质量更高、更贴合客户情况 | P0 |
| CL-02 | 作为客户经理，当我采纳的方案质量较高时，我希望系统自动把它存入案例库，供后续为相似客户生成方案时参考 | P0 |
| CL-03 | 作为客户经理，我可以查看案例库中有哪些案例，并手动删除不合适或过时的案例 | P2 |

---

## 3. 功能需求

### 3.1 提取项定义

从对话和方案中提取 4 类 12 项知识，按目标存储池分类：

| 类别 | 提取项 | 存储池 | 触发时机 | 置信度 |
|------|--------|--------|----------|--------|
| 个人适配 | 话术偏好 | 个人知识库 | 方案采纳 / 显式指令 | 高 |
| 个人适配 | 产品推荐倾向 | 个人知识库 | 方案采纳 / 显式指令 | 高 |
| 个人适配 | 沟通风格 | 个人知识库 | 方案采纳 / 显式指令 | 高 |
| 客户画像 | 隐性偏好发现 | insights | 方案采纳 / 显式指令 | 中 |
| 客户画像 | 风险态度变化 | insights | 显式指令 | 中 |
| 客户画像 | 生命周期事件 | insights | 显式指令 | 中 |
| 策略市场 | 组合策略经验 | 个人知识库 | 方案采纳 | 高 |
| 策略市场 | 市场观点 | insights | 显式指令 | 低 |
| 策略市场 | 客群判断经验 | 个人知识库 | 显式指令 | 中 |
| 流程合规 | 合规修正经验 | 个人知识库 | 方案采纳 / 显式指令 | 中 |
| 流程合规 | 异议处理模式 | 个人知识库 | 方案采纳 / 显式指令 | 中 |
| 流程合规 | 跟进节奏偏好 | 个人知识库 | 显式指令 | 中 |

### 3.2 触发时机

**触发点 1：显式指令（P0）**

- 信号：经理在对话中说「记住」「记下来」「记一下」「这个经验以后也用」
- 动作：AI Agent 调用 `save_knowledge` 工具，调用 `runLlmJson` 执行提取，即时写入知识库或 insights
- 置信度：`high`，直接写入，无需经理确认
- 输入参数：{ 经理文本, 客户画像, 现有知识库, 现有洞察 }，LLM 一次完成提取+去重

**触发点 2：方案采纳（P0）**

- 信号：经理点击「采纳方案」
- 动作：前端 `confirmAdoptPlan` 末尾自动触发（不阻塞 UI），调用 `runLlmJson` 并行执行 6 个提取项
- 置信度：`medium`，写入待确认区，经理在知识库页确认后生效
- 输入参数：{ 方案, 客户画像, 现有知识库, 现有洞察 }，LLM 一次完成提取+去重
- 同时触发案例入库（`score >= 7` 时）

### 3.3 提取参数与去重

提取模块统一输入：

```
{ 提取源, 客户画像, 现有知识库, 现有洞察 }
```

**去重机制**：不依赖后端字符串匹配。LLM 在提取时直接看到现有知识库和洞察，语义理解后天然跳过重复内容。例如：

- 知识库已有「客户偏好保守」→ 对话中客户又说「保守点好」→ LLM 判断重复，跳过
- 知识库已有「推荐固收+」→ 对话中建议「配置 60% 固收理财」→ LLM 判断重复，跳过
- 知识库已有「话术：您好我是XX」→ 新话术「XX经理您好」→ 不同话术，保留

### 3.4 案例库（优秀方案回灌）

#### 3.4.1 案例定义

```typescript
interface CaseRecord {
  caseId: string;
  planId: string;
  customerId: string;
  managerId: string;                 // 经理隔离

  // 结构化检索键（硬过滤）
  segment: string;
  riskTolerance: string;
  lifeCycleStage: string;
  aumLevel: "L1" | "L2" | "L3" | "L4" | "L5";

  // 语义检索向量（仅基于客户画像）
  embedding: number[];

  // 注入 prompt 的摘要（精简版）
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
```

#### 3.4.2 入库策略

- 触发条件：方案被采纳且 `score >= 7`
- 入库时机：采纳时同步写入，与知识提取并行
- 质量标签：`score >= 9` 标记为 `high`，其余为 `medium`
- 重复策略：同一 `planId` 幂等去重，不重复入库
- 经理隔离：案例按 `managerId` 隔离，检索时只检索本经理自己的案例

#### 3.4.3 检索策略

**结构化预过滤 + 语义精排（两步法）：**

```
Step 1（硬过滤）：
  riskTolerance == target.riskTolerance
  AND segment == target.segment
  AND aumLevel == target.aumLevel

Step 2（语义精排）：
  候选集内，按客户画像 embedding 做 cosine 相似度排序
  取 Top-3 作为 reference cases
```

**Phase 1 只按客户画像做向量检索**，向量化字段：客群、风险等级、生命周期、AUM量级、职业、偏好。不包含方案内容。

**兜底策略**：若硬过滤后候选集为空，逐级放宽约束：
1. 去掉 `aumLevel` 约束，用 `riskTolerance + segment` 重新检索
2. 再去掉 `segment` 约束，仅用 `riskTolerance` 检索
3. 全部为空则不注入案例段

#### 3.4.4 案例检索注入方案生成

每次方案生成时，在 `fetchContext` 末尾执行案例检索，结果注入 `WorkflowContext.similarCases`。LLM 叶子节点的 `buildPrompt` 中新增「参考案例」段，位于「业务上下文」之后、「输出要求」之前。

### 3.5 知识确认与反馈闭环

#### 3.5.1 知识库确认机制

- 自动提取的知识统一进入 `status: pending` 待确认区
- 经理在知识库页面可逐条确认（`confirm`）/ 拒绝（`reject`）/ 编辑
- 确认后的知识立即生效，影响后续方案生成的 prompt 注入
- 拒绝的知识标注 `rejected`，不再展示
- 显式指令提取的知识置信度为 `high`，直接写入，不进入待确认区

#### 3.5.2 知识库结构扩展

当前知识库 3 段结构扩展为 5 段：

| 段名 | 说明 | 提取来源 |
|------|------|----------|
| 话术模板 | 开场/需求挖掘/跟进/异议处理话术 | 话术偏好、异议处理 |
| 产品优先度 | 产品推荐顺序与组合策略 | 产品倾向、组合策略 |
| 风格偏好 | 语气与表达风格 | 沟通风格 |
| 合规经验 | 合规审查注意事项与处理技巧 | 合规修正 |
| 跟进策略 | 触客频率与时机偏好 | 跟进节奏 |

> **旧数据兼容（架构审查后补充）**：现有 backend [store.mjs](file:///d:/develop/finance_agent/finclaw/backend/src/store.mjs) 的 `getKnowledge` 默认值为 3 段（话术/产品/风格）。新增「合规经验」「跟进策略」两段时，需确保：
> 1. 旧知识库（3 段）在 `parseKnowledgeMarkdown` 下仍可正常解析，不因缺段报错
> 2. `composeKnowledgeMarkdown` 生成 5 段时，对缺失段输出空内容即可，不必强制补齐

#### 3.5.3 案例库维护

- 经理可在设置页查看案例库概览（数量、质量分布）
- 支持手动删除单个案例
- 每次案例检索时，自动过滤 `createdAt > 180 天` 的旧案例
- 案例量超过 1000 时，自动淘汰 `quality: medium` 且最早入库的 20%

---

## 4. 非功能需求

| 需求 | 指标 | 说明 |
|------|------|------|
| 检索延迟 | < 200ms | 方案生成全链路中案例检索不增加显著延迟 |
| 向量检索准确率 | Top-3 命中率 > 80% | 经结构预过滤后，语义精排应返回与目标客户高度相关的案例 |
| 知识提取准确率 | 置信度"high"的提取项准确率 > 90% | 低置信度提取项误报率应 < 10% |
| 增量成本 | 单次方案生成增量 < 0.01 元 | 检索 embedding 约 0.001 元/次，可忽略 |
| 案例库容量 | 支持每经理 1000 条案例 | 内存 cosine 方案下，1000 条 × 768 维 × 4 字节 ≈ 3MB，可接受 |
| 扩展性 | 案例库应支持后续迁移到向量数据库 | 接口设计为 `CaseStore` 抽象，可替换实现 |

---

## 5. 技术方案概要

> 详细技术方案见 `knowledge-accumulation-tech.md`

### 5.1 核心设计决策

| 决策 | 结论 | 理由 |
|------|------|------|
| 触发时机 | 方案采纳 + 显式指令 | 信号明确，覆盖主要场景，复杂度低 |
| 提取执行者 | `runLlmJson` 直接调用 | 不需要 agent 能力，零状态污染，最轻量 |
| LLM 调用原子 | `runLlmJson` → `runLlmJsonOnce`（共享原子） | 已完成的 P1 优化，`llm-leaf` 与提取统一复用同一临时 session 流程 |
| 提取封装形式 | `extractors.ts` 可调用模块 | 两个入口复用同一模块，不污染 agent 上下文 |
| 去重方式 | LLM 调用时一次性完成 | 输入中包含现有知识库/洞察，语义去重优于字符串匹配 |
| 案例库检索 | 内存 cosine + JSON 文件，零新增依赖 | 案例量 < 1000 时 < 10ms |
| 检索维度 | Phase 1 只按客户画像 | 画像相似天然意味着方案配置方向相似 |

### 5.2 新增文件

| 文件 | 说明 |
|------|------|
| `pi-gateway/src/workflow/case-store.ts` | 案例存储与检索（内存 cosine + JSON 持久化） |
| `pi-gateway/src/workflow/extractors.ts` | 12 个提取项的 prompt 构造与 LLM 调用统一入口 |
| `pi-gateway/src/tools/save-knowledge.ts` | 显式指令工具 `save_knowledge` 定义 |

### 5.3 修改文件

| 文件 | 改动 |
|------|------|
| `pi-gateway/src/workflow/types.ts` | `WorkflowContext` 增加 `similarCases?: CaseSummary[]`；`CustomerProfile` 已补 `birthday/tasks/tags`（P0 已完成） |
| `pi-gateway/src/workflow/backend-client.ts` | `fetchContext` 末尾增加 `caseStore.search()` 调用 |
| `pi-gateway/src/workflow/llm-leaf.ts` | `buildPrompt` 增加「参考案例」段注入；已复用 `runLlmJsonOnce`（P1 已完成） |
| `pi-gateway/src/workflow/self-evolve.ts` | `runSuggestKnowledge` 扩展为 6 项提取 + 案例入库 |
| `pi-gateway/src/agent-session.ts` | 注册 `save_knowledge` 工具 |
| `pi-gateway/src/tools/customer-analyze.ts` | 在 `createCustomTools()` 中追加 `save_knowledge` 工具（**无 `tools/index.ts`**） |
| `web/src/main.ts` | `confirmAdoptPlan` 末尾自动触发知识提取（不阻塞 UI） |
| `backend/src/routes/knowledge.routes.mjs` | 新增待确认列表、批量确认/拒绝接口 |
| `backend/src/routes/case-store.routes.mjs` | 新增案例列表、删除接口 |
| `backend/src/server.mjs` | 注册新路由 |
| `backend/src/store.mjs` | 增加 `pending-knowledge.json` 存取 |

### 5.4 技术选型

| 组件 | 选型 | 理由 |
|------|------|------|
| 向量存储 | 内存 JSON 文件（Phase 1） | 案例量 < 1000，零基础设施成本 |
| 向量检索 | 手动 cosine 相似度 | 候选集小（< 100 条），可用原生 JS 实现 |
| Embedding | DeepSeek embedding API | 已有 DeepSeek API Key，零新增依赖 |
| 提取 LLM | DeepSeek chat（`runLlmJson`） | 复用现有 `llm-json.ts` |
| 持久化 | JSON 文件，`case-store.json` | 与现有 `store.mjs` 风格一致 |
| 案例质量 | `score >= 7` 入库，`score >= 9` 标记 high | 复用现有方案评分字段 |

---

## 6. 实施计划

### 6.1 里程碑

| 里程碑 | 内容 | 预估人日 | 依赖 |
|--------|------|---------|------|
| M0 · 案例库 | `case-store.ts` + `fetchContext` 改造 + `buildPrompt` 注入 | 2 | 无 |
| M1 · 提取框架 | 12 个提取 prompt 实现 + `runLlmJson` 包装 + 统一入口 | 3 | 无 |
| M2 · 触发集成 | 方案采纳触发 + `save_knowledge` 工具 + 前端改动 | 2 | M0 + M1 |
| M3 · 确认闭环 | 知识库扩展 + 待确认区 + 后端接口 | 2 | M1 |
| M4 · 端到端验证 | 集成测试 + 性能验证 | 1 | M0-M3 |
| **合计** | | **10** | |

### 6.2 发布条件

- [ ] 显式指令触发：Agent 识别「记住」并正确调用 `save_knowledge` 工具，知识即时写入
- [ ] 方案采纳触发：采纳按钮自动触发知识提取，结果写入待确认区
- [ ] 案例检索：Top-3 返回与目标客户画像高度相关
- [ ] 方案生成时正确注入参考案例段
- [ ] 确认/拒绝机制正常运作
- [ ] 所有改动不影响现有方案生成和合规审查流程
- [ ] 存量测试用例全部通过

---

## 7. 风险与缓解

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| 提取噪声过高，经理频繁拒绝 | 中 | 高 | 显式指令直接写入，方案采纳提取进入待确认区；低置信度结果不展示 |
| 案例检索结果不相关，反而干扰方案生成 | 低 | 中 | 注入位置在「参考」段，不是强制约束；LLM 自主判断是否参考 |
| 提取 LLM 调用量增加，成本上升 | 低 | 低 | 每次提取约 500 tokens，单次成本 < 0.001 元；方案采纳 6 项并行调用约 0.006 元 |
| 知识库内容膨胀，维护困难 | 低 | 中 | LLM 去重（输入含现有知识库）、180 天过期淘汰、人工删除入口 |
| 案例库 embedding 与 DeepSeek 模型版本不兼容 | 低 | 低 | embedding 结果独立存储，模型升级后重新生成即可 |