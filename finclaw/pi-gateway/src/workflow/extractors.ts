/**
 * M1 · 知识提取模块
 *
 * 从对话/被采纳方案中提取可复用知识(话术/产品/风格/组合/合规/异议/跟进)
 * 与客户洞察,LLM 一次调用完成「提取 + 去重」(输入含现有知识库/洞察全文)。
 *
 * 设计:
 * - 统一入口 extractKnowledge:构造 prompt → runLlmJson → 解析结果
 * - 8 类提取项共享通用模板,核心差异在「提取要求」段
 * - 去重完全由 LLM 语义判断,后端不做字符串匹配
 * - 空结果(isEmpty)不写入任何存储,调用方据此判断是否继续
 */

import { runLlmJson } from "./llm-json.ts";
import type { CustomerProfile, MarketingPlan } from "./types.ts";

// ========== 类型定义 ==========

export type KnowledgeCategory =
	| "talkTemplates" // 话术偏好 → 个人知识库
	| "productPriority" // 产品推荐倾向 → 个人知识库
	| "stylePreference" // 沟通风格 → 个人知识库
	| "combinationStrategy" // 组合策略经验 → 个人知识库
	| "compliance" // 合规修正经验 → 个人知识库
	| "objectionHandling" // 异议处理模式 → 个人知识库
	| "followUp" // 跟进节奏偏好 → 个人知识库
	| "customerInsight"; // 客户洞察 → insights

/** 现有洞察(用于去重参考) */
export interface InsightRef {
	content: string;
	tags?: string[];
}

export interface ExtractionRequest {
	category: KnowledgeCategory;
	// 提取源(二选一或同时提供)
	conversation?: string; // 对话片段/显式指令
	plan?: MarketingPlan; // 被采纳的方案(方案采纳场景)
	// 客户画像(所有提取场景都需要)
	customer: CustomerProfile;
	// 去重参考(LLM 看到后天然跳过重复内容)
	existingKnowledge?: string; // 现有知识库 Markdown 全文
	existingInsights?: InsightRef[]; // 现有洞察列表
	// 上下文
	managerId: string;
}

export interface ExtractionResult {
	content: string; // 提取的知识文本(单条)
	tags: string[]; // 标签
	summary: string; // 提取依据说明
	confidence: "high" | "medium" | "low";
	category: KnowledgeCategory;
	/** 空结果标识(LLM 判断无新内容时返回 true) */
	isEmpty: boolean;
}

// ========== 提取项要求(通用模板核心差异) ==========

interface CategorySpec {
	/** 提取源侧重:对话 / 方案 / 两者 */
	source: "conversation" | "plan" | "both";
	/** 「提取要求」段正文 */
	requirement: string;
}

/** 各段通用质量要求：精炼、客户经理层次、与具体客户无关 */
const QUALITY_RULES =
	"提炼质量标准（必须同时满足）：\n" +
	"1. 客户经理层次：提炼的是可复用的营销原则/方法论/操作策略，供客户经理日后借鉴，而非流水账式描述。\n" +
	"2. 与客户无关：不得出现客户姓名、客户 ID、具体金额、日期、单一产品名等个案细节；若源中含个案，应抽象为通用规则（如“该客户”改为“客户”）。\n" +
	"3. 精炼：一句高度概括的话（不超过 40 字），每类最多输出 1 条，宁缺毋滥。\n" +
	"4. 无明显可复用价值的内容不要提取。";

const CATEGORY_SPECS: Record<KnowledgeCategory, CategorySpec> = {
	talkTemplates: {
		source: "both",
		requirement:
			"提炼可复用的沟通话术原则（开场/需求挖掘/跟进/推荐时的表达策略），直接可追加到知识库「话术模板」段。\n" +
			QUALITY_RULES,
	},
	productPriority: {
		source: "both",
		requirement:
			"提炼产品推荐策略：推荐顺序、品类搭配逻辑（如固收打底、权益增强）及适用条件，直接可追加到知识库「产品优先度」段。\n" +
			QUALITY_RULES,
	},
	stylePreference: {
		source: "both",
		requirement:
			"提炼经理的沟通风格偏好：语气正式/亲切、长短句偏好、专业术语使用等，直接可追加到知识库「风格偏好」段。\n" +
			QUALITY_RULES,
	},
	combinationStrategy: {
		source: "plan",
		requirement:
			"提炼可复用的组合配置策略：如「固收+现金打底、权益小仓位增强」的思路与比例参考，直接可追加到知识库「产品优先度」段。\n" +
			QUALITY_RULES,
	},
	compliance: {
		source: "both",
		requirement:
			"提炼合规处理经验：风险揭示语写法、违禁词规避方式、风险等级匹配处理技巧，直接可追加到知识库「合规经验」段。\n" +
			QUALITY_RULES,
	},
	objectionHandling: {
		source: "conversation",
		requirement:
			"提炼应对客户异议的话术策略：客户常见拒绝理由与对应的应对思路，直接可追加到知识库「话术模板」段。\n" +
			QUALITY_RULES,
	},
	followUp: {
		source: "conversation",
		requirement:
			"提炼跟进策略：触客频率、到期提醒时机、回访间隔等节奏偏好，直接可追加到知识库「跟进策略」段。\n" +
			QUALITY_RULES,
	},
	customerInsight: {
		source: "both",
		requirement:
			"提炼可复用的客户洞察（隐性偏好/风险态度变化/生命周期事件/市场观点/客群经验），用于沉淀到客户画像 insights。\n" +
			"该类别面向具体客户，可保留个案细节，但每条聚焦一个可复用的客户特征，2-3 句话含具体表现。",
	},
};

// ========== Prompt 构造 ==========

/** 格式化客户画像为 JSON(仅选取用于提取的画像字段) */
function formatCustomer(customer: CustomerProfile): string {
	return JSON.stringify(
		{
			customerId: customer.customerId,
			name: customer.name,
			segment: customer.segment,
			occupation: customer.occupation,
			riskTolerance: customer.riskTolerance,
			aum: customer.aum,
			lifeCycleStage: customer.lifeCycleStage,
			preferences: customer.preferences,
		},
		null,
		2,
	);
}

/** 格式化被采纳方案为 Markdown 文本 */
function formatPlan(plan: MarketingPlan): string {
	const allocationLines = Object.entries(plan.allocation ?? {})
		.map(([k, v]) => `- ${k}: ${v.pct}%（${(v.products || []).join("、")}）`)
		.join("\n");
	const productLines = (plan.products || [])
		.map((p) => `- ${p.name}（${p.category}/${p.riskLevel}）：${p.reason}`)
		.join("\n");
	return [
		`标题：${plan.title}`,
		`评分：${plan.score}`,
		`诊断：${plan.diagnosis}`,
		`标签：${(plan.tags ?? []).join("、")}`,
		"配置比例：",
		allocationLines || "（无）",
		"推荐产品：",
		productLines || "（无）",
		"企业微信话术：",
		plan.scripts?.wecom || "（无）",
	].join("\n");
}

/**
 * 构造提取 prompt(通用模板)。
 * 各类别差异集中在「## 提取要求」段,由 CATEGORY_SPECS 提供。
 */
export function buildExtractionPrompt(req: ExtractionRequest): string {
	const spec = CATEGORY_SPECS[req.category];

	// 提取源:按类别侧重选择 plan / conversation,两者都提供时优先方案
	const sourceBlocks: string[] = [];
	if (req.plan && spec.source !== "conversation") {
		sourceBlocks.push("## 提取源（被采纳的方案）", "```text", formatPlan(req.plan), "```");
	}
	if (req.conversation && spec.source !== "plan") {
		sourceBlocks.push("## 提取源（对话/指令）", "```text", req.conversation, "```");
	}

	return [
		"你是银行客户经理的经验沉淀助手。只输出 JSON，不加解释或代码围栏。",
		"",
		"## 客户画像",
		"```json",
		formatCustomer(req.customer),
		"```",
		"",
		...sourceBlocks,
		"",
		"## 现有知识库（供去重参考，避免重复提取）",
		"```text",
		req.existingKnowledge?.trim() || "（空）",
		"```",
		"",
		"## 现有洞察（供去重参考，避免重复提取）",
		"```json",
		JSON.stringify(req.existingInsights ?? [], null, 2),
		"```",
		"",
		"## 提取要求",
		spec.requirement,
		"判断标准：如果现有知识库/洞察中已有语义等价的内容，视为重复，返回空结果。",
		"",
		"## 输出要求",
		'只输出一个 JSON 对象，结构为 { "content": "提取的知识文本（单条，不超过 40 字）", "tags": ["标签1"], "summary": "提取依据说明", "confidence": "high|medium|low", "isEmpty": true|false }，不加解释或代码围栏。',
	].join("\n");
}

// ========== 结果解析 ==========

const CONFIDENCE_LEVELS: ExtractionResult["confidence"][] = ["high", "medium", "low"];

export function parseExtractionResult(
	parsed: unknown,
	category: KnowledgeCategory,
): ExtractionResult {
	const obj =
		parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
	const content = typeof obj.content === "string" ? obj.content.trim() : "";
	// LLM 显式标记 isEmpty,或未输出任何内容 → 空结果
	const isEmpty = obj.isEmpty === true || !content;

	return {
		content,
		tags: Array.isArray(obj.tags)
			? obj.tags.filter((t): t is string => typeof t === "string")
			: [],
		summary: typeof obj.summary === "string" ? obj.summary : "",
		confidence: CONFIDENCE_LEVELS.includes(obj.confidence as never)
			? (obj.confidence as ExtractionResult["confidence"])
			: "low",
		category,
		isEmpty,
	};
}

// ========== 统一入口 ==========

/**
 * 执行一次知识提取。
 * 输入含现有知识库/洞察,LLM 一次完成提取 + 语义去重。
 * 调用方根据 result.isEmpty 决定是否写入存储。
 */
export async function extractKnowledge(
	req: ExtractionRequest,
	piAgentDir: string,
): Promise<ExtractionResult> {
	const systemPrompt =
		"你是银行客户经理的经验沉淀助手。只输出 JSON，不加解释或代码围栏。";
	const parsed = await runLlmJson(piAgentDir, systemPrompt, buildExtractionPrompt(req));
	return parseExtractionResult(parsed, req.category);
}

// ========== 类别判定(显式指令场景) ==========

const CATEGORY_ALIASES: Record<string, KnowledgeCategory> = {
	// 英文键统一小写(与 guessCategory 的 toLowerCase 对齐)
	talktemplates: "talkTemplates",
	productpriority: "productPriority",
	stylepreference: "stylePreference",
	combinationstrategy: "combinationStrategy",
	compliance: "compliance",
	objectionhandling: "objectionHandling",
	followup: "followUp",
	customerinsight: "customerInsight",
	话术: "talkTemplates",
	话术模板: "talkTemplates",
	产品: "productPriority",
	产品优先: "productPriority",
	风格: "stylePreference",
	沟通风格: "stylePreference",
	组合: "combinationStrategy",
	配置: "combinationStrategy",
	合规: "compliance",
	异议: "objectionHandling",
	跟进: "followUp",
	洞察: "customerInsight",
};

/**
 * 根据显式指令中的 category 参数(可为空)与内容关键词判定提取类别。
 * category 参数优先;缺失时按内容启发式兜底,默认归为客户洞察。
 */
export function guessCategory(input?: string, content?: string): KnowledgeCategory {
	const key = input?.trim().toLowerCase() ?? "";
	if (key && key in CATEGORY_ALIASES) {
		return CATEGORY_ALIASES[key];
	}
	if (content) {
		if (/话术|怎么说|如何说|开场|称呼/.test(content)) return "talkTemplates";
		if (/产品|推荐|优先|选品/.test(content)) return "productPriority";
		if (/风格|语气|亲切|正式|口吻/.test(content)) return "stylePreference";
		if (/组合|打底|配置比例|策略/.test(content)) return "combinationStrategy";
		if (/合规|违禁|风险揭示|报备/.test(content)) return "compliance";
		if (/异议|拒绝|反对|应对/.test(content)) return "objectionHandling";
		if (/跟进|回访|提醒|触客|节奏/.test(content)) return "followUp";
	}
	return "customerInsight";
}

// ========== 候选提炼(对话上下文批量沉淀) ==========

/** 候选知识项（供前端弹窗多选确认） */
export interface KnowledgeCandidate {
	category: KnowledgeCategory;
	content: string;
	tags: string[];
	summary: string;
	confidence: "high" | "medium" | "low";
}

const CANDIDATE_CATEGORIES = [
	"talkTemplates",
	"productPriority",
	"stylePreference",
	"combinationStrategy",
	"compliance",
	"objectionHandling",
	"followUp",
] as const;

/** 解析候选提炼结果：兼容数组 / { candidates } / { items } 三种形态 */
export function parseCandidatesResult(parsed: unknown): KnowledgeCandidate[] {
	const raw = Array.isArray(parsed)
		? parsed
		: parsed && typeof parsed === "object"
			? ((parsed as Record<string, unknown>).candidates ??
				(parsed as Record<string, unknown>).items)
			: undefined;
	if (!Array.isArray(raw)) return [];
	const result: KnowledgeCandidate[] = [];
	for (const item of raw) {
		if (!item || typeof item !== "object") continue;
		const obj = item as Record<string, unknown>;
		const content = typeof obj.content === "string" ? obj.content.trim() : "";
		if (!content) continue;
		const category = CANDIDATE_CATEGORIES.includes(obj.category as never)
			? (obj.category as KnowledgeCategory)
			: "talkTemplates";
		result.push({
			category,
			content,
			tags: Array.isArray(obj.tags)
				? obj.tags.filter((t): t is string => typeof t === "string")
				: [],
			summary: typeof obj.summary === "string" ? obj.summary : "",
			confidence: CONFIDENCE_LEVELS.includes(obj.confidence as never)
				? (obj.confidence as KnowledgeCandidate["confidence"])
				: "medium",
		});
		if (result.length >= 5) break; // 最多 5 条
	}
	return result;
}

/**
 * 从对话历史中批量提炼可沉淀的候选知识项（最多 5 条）。
 * 输入含现有知识库全文做去重参考，输出供用户弹窗多选确认。
 */
export async function extractCandidates(
	conversation: string,
	existingKnowledge: string,
	managerId: string,
	piAgentDir: string,
): Promise<KnowledgeCandidate[]> {
	const systemPrompt =
		"你是银行客户经理的经验沉淀助手。只输出 JSON，不加解释或代码围栏。";
	const userPrompt = [
		"阅读下面的对话历史，从中提炼可复用的经验知识，供客户经理确认后沉淀到个人知识库。",
		"",
		"## 对话历史",
		"```text",
		conversation.trim() || "（空）",
		"```",
		"",
		"## 现有知识库（供去重参考，避免重复提炼）",
		"```text",
		existingKnowledge.trim() || "（空）",
		"```",
		"",
		"## 提取要求",
		`从对话中提炼可复用的经验，类别限定为：${CANDIDATE_CATEGORIES.join("/")}。`,
		QUALITY_RULES,
		"- 最多输出 5 条，宁缺毋滥；只提炼明确的、可复用的经验，忽略闲聊",
		"- 与现有知识库语义重复的内容不要输出",
		"- 每条聚焦一个知识点，content 直接可追加到对应知识库段",
		"",
		"## 输出要求",
		'只输出一个 JSON 数组，元素结构为 { "category": "类别", "content": "知识内容（单条，不超过 40 字）", "tags": ["标签"], "summary": "一句话说明为什么值得沉淀", "confidence": "high|medium|low" }，不加解释或代码围栏。',
	].join("\n");

	const parsed = await runLlmJson(piAgentDir, systemPrompt, userPrompt);
	return parseCandidatesResult(parsed);
}
