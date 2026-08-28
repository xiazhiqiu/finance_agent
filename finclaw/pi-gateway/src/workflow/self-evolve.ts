/**
 * M4 · 自进化沉淀：方案接受洞察提取 + 知识库建议
 *
 * 从被接受的方案中沉淀可复用洞察（写入 backend insights[]）与
 * 个人知识库内容建议（经理确认后写入）。
 */

import { createBackendClient, backendReadInsights } from "./backend-client.ts";
import {
	buildExtractInsightPrompt,
} from "./prompts.ts";
import { runLlmJson } from "./llm-json.ts";
import { extractKnowledge, type KnowledgeCategory } from "./extractors.ts";
import { getCaseStore } from "./case-store.ts";
import { backendGet } from "../tools/backend-http.ts";
import type { MarketingPlan } from "./types.ts";

export interface ExtractInsightRequest {
	customerId: string;
	managerId: string;
	plan: MarketingPlan;
}

export interface ExtractedInsight {
	content: string;
	tags: string[];
}

/**
 * M4.1 · 从被接受的方案中提取洞察（双源汇聚的"方案接受"通道）。
 * 输出写入 backend insights[]，source = 'accepted'，进入待确认区。
 */
export async function runExtractInsightFromPlan(
	req: ExtractInsightRequest,
	piAgentDir: string,
): Promise<ExtractedInsight> {
	const backend = createBackendClient();
	const context = await backend.fetchContext(req.customerId, req.managerId, "customer");
	const { customer } = context;

	const systemPrompt =
		"你是银行客户经理的洞察分析助手。只输出 JSON，不加解释或代码围栏。";
	const userPrompt = buildExtractInsightPrompt(customer, req.plan);

	const parsed = await runLlmJson(piAgentDir, systemPrompt, userPrompt);
	if (
		parsed &&
		typeof parsed === "object" &&
		typeof (parsed as { content?: unknown }).content === "string"
	) {
		const obj = parsed as { content: string; tags?: unknown };
		return {
			content: obj.content,
			tags: Array.isArray(obj.tags)
				? obj.tags.filter((t): t is string => typeof t === "string")
				: ["方案洞察"],
		};
	}
	throw new Error("方案洞察提取失败：LLM 输出解析失败");
}

export interface KnowledgeSuggestRequest {
	customerId: string;
	managerId: string;
	plan: MarketingPlan;
}

/** 扩展提取项（方案采纳场景，超出原有 3 段的类别） */
export interface KnowledgeExtraItem {
	category: KnowledgeCategory;
	content: string;
	tags: string[];
	summary: string;
	confidence: "high" | "medium" | "low";
}

export interface KnowledgeSuggestion {
	talkTemplates: string;
	productPriority: string;
	stylePreference: string;
	/** 扩展提取项（组合策略/合规/异议处理），向后兼容，原 3 段字段不变 */
	extra: KnowledgeExtraItem[];
}

/** 方案采纳场景并行提取的 6 个类别（含原有 3 段） */
const SUGGEST_CATEGORIES: KnowledgeCategory[] = [
	"talkTemplates",
	"productPriority",
	"stylePreference",
	"combinationStrategy",
	"compliance",
	"objectionHandling",
];

/**
 * M4.2 · 从敲定方案中沉淀个人知识库建议（自动沉淀为辅，经理确认写入）。
 *
 * 扩展为 6 个提取项（话术/产品/风格/组合/合规/异议），并行执行、过滤空结果；
 * 方案 score >= 7 时同步写入案例库（embedding 失败静默降级，不阻断提取）。
 */
export async function runSuggestKnowledge(
	req: KnowledgeSuggestRequest,
	piAgentDir: string,
): Promise<KnowledgeSuggestion> {
	const backend = createBackendClient();
	const context = await backend.fetchContext(req.customerId, req.managerId, "customer");
	const { customer } = context;

	// 读取现有知识库/洞察（供 LLM 语义去重）
	const existingKnowledge = context.personalKnowledge;
	const existingInsights = await backendReadInsights(req.customerId, req.managerId);

	// 未及时采纳的建议也要参与去重：待确认(pending)知识虽未写入知识库，但已提取过，
	// 避免同一条建议被反复提取。
	const pending = await backendGet<Array<{ content?: string }>>(
		"/api/knowledge/pending",
		req.managerId,
	).catch(() => []);
	const pendingKnowledge = (pending ?? [])
		.map((p) => p.content ?? "")
		.filter(Boolean)
		.join("\n");
	const dedupKnowledge = existingKnowledge
		? `${existingKnowledge}\n${pendingKnowledge}`
		: pendingKnowledge;

	// 并行执行 6 个提取项
	const results = await Promise.all(
		SUGGEST_CATEGORIES.map((category) =>
			extractKnowledge(
				{
					category,
					plan: req.plan,
					customer,
					existingKnowledge: dedupKnowledge,
					existingInsights,
					managerId: req.managerId,
				},
				piAgentDir,
			),
		),
	);

	const pick = (category: KnowledgeCategory) =>
		results.find((r) => r.category === category && !r.isEmpty)?.content ?? "";

	// 案例入库：score >= 7 的优秀方案回灌（失败不阻断知识提取）
	if (req.plan.score >= 7) {
		try {
			await getCaseStore().addFromPlan(req.plan, customer, req.managerId);
		} catch (err) {
			console.warn("[self-evolve] 案例入库失败（不影响知识提取）:", err);
		}
	}

	return {
		talkTemplates: pick("talkTemplates"),
		productPriority: pick("productPriority"),
		stylePreference: pick("stylePreference"),
		extra: results
			.filter((r) => !r.isEmpty)
			.map((r) => ({
				category: r.category,
				content: r.content,
				tags: r.tags,
				summary: r.summary,
				confidence: r.confidence,
			})),
	};
}