export interface CustomerSummary {
  customerId: string;
  name: string;
  segment?: string;
  riskTolerance?: string;
  aum?: number;
  tasks?: MarketingTask[];
  tags?: string[];
}

export interface CustomerProfile extends CustomerSummary {
  occupation?: string;
  aum: number;
  aumStructure?: Record<string, number>;
  upcomingMaturities?: Array<{ amount: number; dueDate: string; productType: string }>;
  recentTransactions?: string;
  lastContact?: { channel: string; date: string; topic: string };
  preferences?: string[];
  lifeCycleStage?: string;
  riskAssessmentDate?: string;
  birthday?: string;
  /** 最新一条客户洞察全文（按创建时间倒序，无洞察为 null） */
  latestInsight?: Insight | null;
}

export interface MarketingPlan {
  planId: string;
  customerId: string;
  title: string;
  score: number;
  tags: string[];
  diagnosis: string;
  allocation: Record<string, { pct: number; products: string[] }>;
  products: Array<{
    productId: string;
    name: string;
    category: string;
    subCategory?: string;
    riskLevel: string;
    tenor?: string;
    expectedReturn?: string;
    reason: string;
  }>;
  scripts: { wecom: string; phone: string[] };
  markdown: string;
}

export interface ComplianceReport {
  passed: boolean;
  riskMismatch: boolean;
  mismatchedProducts: Array<{ productId: string; name: string; reason: string }>;
  offSaleProducts: Array<{ productId: string; name: string; reason: string }>;
  forbiddenWords: Array<{ word: string; context: string; suggestion: string }>;
  missingRiskDisclosures: string[];
  summary: string;
  markdown: string;
}

export interface GenerateResult {
  plans: MarketingPlan[];
  attempt?: number;
  compliance?: ComplianceReport;
}

// 方案会话(完整记录,持久化到 plan_sessions.json)
// sessionKey 绑定 pi-gateway 的 AgentSession(对话上下文),一次对话会话 = 后端 PlanSession + Pi SDK AgentSession
export interface PlanSession {
  sessionId: string;
  customerId: string;
  managerId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  plans: MarketingPlan[];
  selectedPlanId: string;
  adoptedPlanId?: string; // 已成交方案的 planId（独立于 selectedPlanId）
  lastInstruction: string;
  complianceReport: ComplianceReport | null;
  sessionKey?: string;
}

// 方案会话摘要(列表用,字段与 PlanSession 一致,但 plans 通常为空以减少传输)
export interface PlanSessionSummary {
  sessionId: string;
  customerId: string;
  managerId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  plans: MarketingPlan[];
  selectedPlanId: string;
  adoptedPlanId?: string; // 已成交方案的 planId（独立于 selectedPlanId）
  lastInstruction: string;
  complianceReport: ComplianceReport | null;
  sessionKey?: string;
}

export interface PersonalKnowledge {
  talkTemplates: string;
  productPriority: string;
  stylePreference: string;
  compliance: string;
  followUp: string;
  content?: string;
}

// M5.2 · 记忆沉淀候选知识项（弹窗多选确认）
export interface KnowledgeCandidate {
  category: string;
  content: string;
  tags: string[];
  summary: string;
  confidence: string;
}

/** M4.2 · 方案采纳知识沉淀建议（pi-gateway 返回：3 段 + 扩展项） */
export interface KnowledgeSuggestion {
  talkTemplates: string;
  productPriority: string;
  stylePreference: string;
  /** 扩展提取项（组合策略/合规/异议处理），并入对应知识库段 */
  extra: Array<{
    category: string;
    content: string;
    tags: string[];
    summary: string;
    confidence: string;
  }>;
}

/** 待确认知识（PRD §3.5.1：方案采纳提取进入 pending，经理确认后并入知识库） */
export interface PendingKnowledgeItem {
  id: string;
  managerId: string;
  field: string;
  content: string;
  tags?: string[];
  summary?: string;
  confidence?: string;
  source?: string;
  status: "pending" | "confirmed" | "rejected";
  createdAt: string;
  confirmedAt: string | null;
}

/** M0 · 相似案例（案例检索结果项，对齐 pi-gateway CaseSummary） */
export interface CaseItem {
  caseId: string;
  title: string;
  diagnosis: string;
  score: number;
  tags: string[];
  allocation: Record<string, { pct: number; products: string[] }>;
  products: Array<{ name: string; category: string; riskLevel: string; reason: string }>;
}

/** M3 · 案例库管理列表项（listCases 返回，含元信息） */
export interface CaseStoreItem {
  caseId: string;
  customerId: string;
  summary: CaseItem;
  quality: "high" | "medium";
  createdAt: string;
}

export interface AppConfig {
  apiUrl: string;
  gatewayUrl: string;
  gatewayToken: string;
  agentId: string;
  managerId: string;
}

export interface UserInfo {
  managerId: string;
  name: string;
  role: "admin" | "manager";
  avatar: string;
}

export interface ManagerInfo {
  managerId: string;
  username: string;
  name: string;
  customerCount: number;
}

export interface AdminCustomer extends CustomerProfile {
  assignedManagerId: string | null;
  assignedManagerName: string | null;
}

export interface CreateManagerRequest {
  username: string;
  name: string;
}

export interface EditManagerRequest {
  username?: string;
  name?: string;
}

export interface CreateCustomerRequest {
  name: string;
}

export interface EditCustomerNameRequest {
  name: string;
}

export interface AssignCustomerRequest {
  managerId: string | null;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface ResetPasswordRequest {
  oldPassword: string;
  newPassword: string;
}

export interface PublicResetPasswordRequest {
  username: string;
  oldPassword: string;
  newPassword: string;
}

// ========== M0/M3 新增类型 ==========

// ========== M5 · 对话界面统一改造 ==========

/** 右栏对话气泡消息（聊天界面渲染用） */
export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  /** 该轮工具调用返回的方案卡片（GenerateResult） */
  plans?: GenerateResult;
  /** 工具执行状态提示，如"AI 正在处理…" */
  toolStatus?: string;
  /** 是否正在流式输出 */
  streaming?: boolean;
  timestamp?: string;
  /** 记忆沉淀候选卡片（对话内嵌，单卡独立采纳入库） */
  candidates?: KnowledgeCandidate[];
  /** 候选卡片是否已确认（确认后显示完成态） */
  candidateDone?: boolean;
  /** 候选卡片确认后的结果文案（如"已沉淀 N 条经验"） */
  resultText?: string;
  /** M0 · 案例检索结果卡片（对话内嵌展示相似成交案例） */
  cases?: CaseItem[];
}

/** pi-gateway 历史会话摘要（GET /api/sessions，sessionId 为 safeKey） */
export interface GatewaySessionSummary {
  sessionId: string;
  title: string;
  messageCount: number;
  lastActivity: string;
  lastMessage?: string;
}

/** pi-gateway 历史会话单条消息（GET /api/sessions/{id}/messages） */
export interface GatewaySessionMessage {
  role: string;
  content: string;
  timestamp?: string;
  /** 后端透传的方案结果（GenerateResult），存在时可直接还原方案卡片 */
  plans?: GenerateResult;
}

export interface MarketingStrategy {
  id: string;
  name: string;
  category: string;
  priority: number;
}

export interface MarketingTask {
  taskId: string;
  customerId: string;
  strategyType: string;
  strategyName: string;
  category: string;
  status: "pending" | "done" | "skipped";
  source: "rule" | "llm" | "manual";
  priority: number;
  triggerCondition: string;
  createdAt: string;
}

export interface Insight {
  insightId: string;
  customerId: string;
  source: "llm" | "accepted";
  content: string;
  tags: string[];
  status: "pending" | "confirmed" | "rejected";
  createdAt: string;
  confirmedAt: string | null;
}

export interface BatchJob {
  jobId: string;
  type: "insight" | "plans";
  managerId: string;
  status: "running" | "completed" | "failed";
  total: number;
  succeeded: number;
  failed: number;
  failures: Array<{ customerId: string; error: string }>;
  createdAt: string;
  completedAt: string | null;
}

export interface Reminders {
  insightPending: number;
  batchCompleted: string;
  auditPending: number;
  awakenSuggestion: number;
}

export interface BatchInsightResult {
  job: BatchJob | null;
  results: {
    total: number;
    succeeded: number;
    failed: number;
    failures: Array<{ customerId: string; error: string }>;
    skipped?: Array<{ customerId: string; reason: "pending" | "unchanged" }>;
  };
}

export interface BatchInsightRequest {
  customerIds?: string[];
  onlyChanged?: boolean;
}

export interface EditCustomerProfileRequest {
  segment?: string;
  occupation?: string;
  riskTolerance?: string;
  aum?: number;
  aumStructure?: Record<string, number>;
  upcomingMaturities?: Array<{ amount: number; dueDate: string; productType: string }>;
  recentTransactions?: string;
  lastContact?: { channel: string; date: string; topic: string };
  preferences?: string[];
  lifeCycleStage?: string;
  riskAssessmentDate?: string;
  birthday?: string;
  /** 编辑画像时回写最新一条洞察的内容（覆盖 content） */
  latestInsight?: string;
}
