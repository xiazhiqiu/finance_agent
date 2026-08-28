/**
 * Workflow 引擎类型定义
 *
 * 对齐 web/src/types.ts 与 backend/src/compliance.mjs 的数据结构,
 * 供 orchestrator 与依赖注入使用。
 */

// ========== 业务数据结构(对齐 backend seed.json) ==========

export interface CustomerProfile {
	customerId: string;
	name: string;
	segment?: string;
	occupation?: string;
	riskTolerance: string;
	aum: number;
	aumStructure?: Record<string, number>;
	upcomingMaturities?: Array<{ amount: number; dueDate: string; productType: string }>;
	recentTransactions?: string;
	lastContact?: { channel: string; date: string; topic: string };
	preferences?: string[];
	lifeCycleStage?: string;
	riskAssessmentDate?: string;
	birthday?: string;
	tasks?: Array<{ taskId: string; strategyType: string; strategyName: string; status: string; priority: number }>;
	tags?: string[];
}

export interface Product {
	productId: string;
	name: string;
	category: string;
	riskLevel: string;
	minAmount: number;
	availableQuota: number;
	onSale: boolean;
	tenor: string;
	expectedReturn: string;
	campaigns: string[];
	/** 全字段详情（对齐 seed.json，供叶子参考与前端详情） */
	subCategory?: string;
	description?: string;
	benchmark?: string;
	returns?: Record<string, number>;
	marketTags?: string[];
	scriptTemplate?: string;
	highlights?: string[];
}

/** 客户命中的营销任务（取自 customer_tasks.json，注入叶子供 LLM 参考） */
export interface CustomerTask {
	taskId: string;
	customerId: string;
	strategyType: string;
	strategyName: string;
	category: string;
	priority: number;
	triggerCondition: string;
	status: string;
	source: string;
	createdAt: string;
}

// ========== 方案与合规(对齐 web/src/types.ts) ==========

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
		riskLevel: string;
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

// ========== 案例库（M0 · 优秀方案回灌） ==========

/** 注入 prompt 的案例摘要（精简版，不含 embedding/客户敏感字段） */
export interface CaseSummary {
	caseId: string;
	title: string;
	diagnosis: string;
	score: number;
	tags: string[];
	allocation: Record<string, { pct: number; products: string[] }>;
	products: Array<{ name: string; category: string; riskLevel: string; reason: string }>;
}

// ========== Workflow 上下文与请求/响应 ==========

export interface WorkflowContext {
	customer: CustomerProfile;
	products: Product[];
	/** 该客户命中的营销任务（取自 customer_tasks.json），plan scope 拉取并注入叶子 */
	strategies?: CustomerTask[];
	personalKnowledge: string;
	marketBrief?: string;
	/** 相似案例（检索自案例库，缺省为 undefined，不影响现有流程） */
	similarCases?: CaseSummary[];
}

// ========== 上下文组装(ContextBuilder,见 context-memory-design.md 第 4 节) ==========

export type FetchScope = "plan" | "customer";

/** plan scope 白名单投影后的叶子上下文(剔除配额/在售等大字段,保留生成参考全字段) */
export interface LeafPlanContext {
	customer: CustomerProfile;
	products: Array<
		Pick<
			Product,
			| "productId"
			| "name"
			| "category"
			| "subCategory"
			| "riskLevel"
			| "tenor"
			| "expectedReturn"
			| "description"
			| "benchmark"
			| "returns"
			| "marketTags"
			| "scriptTemplate"
			| "highlights"
		>
	>;
	/** 该客户命中的营销任务（原样透传） */
	strategies?: CustomerTask[];
	personalKnowledge: string;
	marketBrief?: string;
	/** 相似案例（检索自案例库，缺省为 undefined，不影响现有流程） */
	similarCases?: CaseSummary[];
}

export type WorkflowAction = "generate_plans" | "optimize_plan";

export interface WorkflowRequest {
	action: WorkflowAction;
	payload: {
		customer_id: string;
		manager_id: string;
		instruction?: string;
		target_plan_id?: string;
		previous_plans?: MarketingPlan[];
		/** 可选上下文：如果提供，workflow 不再重新拉取数据（允许部分字段，缺省字段由 workflow 自行拉取填补） */
		context?: Partial<WorkflowContext>;
	};
}

/**
 * Workflow 输出结构对齐 AGENTS.md 输出协议(complianceReport 字段名,非 compliance),
 * 保证前端 parseGenerateResult 与渲染逻辑零改动。
 */
export interface WorkflowResult {
	plans: MarketingPlan[];
	attempt?: number;
	error?: string;
	complianceReport?: ComplianceReport;
}

// ========== 重试指令(移植自 retry-context.mjs) ==========

export type RetryIssueType =
	| "mismatchedProduct"
	| "offSaleProduct"
	| "forbiddenWord"
	| "missingRiskDisclosure";

export interface RetryIssue {
	type: RetryIssueType;
	productId?: string;
	productName?: string;
	detail: string;
	fixSuggestion: string;
}

export interface RetryInstruction {
	planId: string;
	title: string;
	issues: RetryIssue[];
}

// ========== 依赖注入接口(用于 mock 单测) ==========

export interface GenerateParams {
	context: Partial<WorkflowContext>;
	mode: "generate" | "optimize";
	retryInstructions?: RetryInstruction[];
	/** 上一轮输出未通过解析/结构校验时的错误反馈（用于输出格式自动重试修正，区别于合规重试 retryInstructions） */
	retryFeedback?: string;
	previousPlan?: MarketingPlan;
	instruction?: string;
}

export interface BackendClient {
	fetchContext(
		customerId: string,
		managerId: string,
		scope?: FetchScope,
	): Promise<WorkflowContext>;
	audit(customerId: string, plans: MarketingPlan[], managerId: string): Promise<ComplianceReport>;
}

export interface LlmLeaf {
	generatePlans(params: GenerateParams): Promise<MarketingPlan[]>;
}

export interface RetryBuilder {
	buildRetryInstructions(plans: MarketingPlan[], report: ComplianceReport): RetryInstruction[];
}

export interface WorkflowDeps {
	backend: BackendClient;
	llm: LlmLeaf;
	retry: RetryBuilder;
	maxAttempts?: number;
}
