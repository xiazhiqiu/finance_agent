/**
 * 洞察工作流 prompt 构建
 *
 * 集中管理洞察生成、方案接受洞察提取、知识库沉淀建议三类 prompt 的构建，
 * 从 insight-orchestrator 拆出，供 insight-batch 与 self-evolve 复用。
 */

import type { WorkflowContext, CustomerProfile, MarketingPlan } from "./types.ts";

/**
 * 构建批量洞察生成的 prompt。
 */
export function buildInsightPrompt(
	context: WorkflowContext,
	ruleTasks: Array<{ strategyType: string; strategyName: string; triggerCondition: string }>,
): string {
	const { customer } = context;
	const lines: string[] = [
		"你是银行客户经理的洞察分析助手。请基于以下客户信息和规则任务，生成 1-2 条深度营销洞察。",
		"",
		"## 客户画像",
		"```json",
		JSON.stringify(
			{
				customerId: customer.customerId,
				name: customer.name,
				segment: customer.segment,
				riskTolerance: customer.riskTolerance,
				aum: customer.aum,
				aumStructure: customer.aumStructure,
				upcomingMaturities: customer.upcomingMaturities,
				lifeCycleStage: customer.lifeCycleStage,
			},
			null,
			2,
		),
		"```",
		"",
		"## 规则层已识别的任务",
	];

	if (ruleTasks.length > 0) {
		lines.push("```json");
		lines.push(JSON.stringify(ruleTasks, null, 2));
		lines.push("```");
	} else {
		lines.push("（无规则任务触发）");
	}

	lines.push(
		"",
		"## 输出要求",
		'只输出一个 JSON 对象，结构为 { "content": "洞察文本（2-3句话，含具体建议）", "tags": ["标签1", "标签2"] }，不加解释或代码围栏。',
		"洞察应聚焦于：1) 资产配置优化机会 2) 即将到期资金承接 3) 风险评估到期提醒 4) 沉睡客户唤醒时机",
		"洞察文本应具体可执行，避免空泛建议。",
	);

	return lines.join("\n");
}

/**
 * 构建从被接受方案中提取洞察的 prompt。
 */
export function buildExtractInsightPrompt(
	customer: CustomerProfile,
	plan: MarketingPlan,
): string {
	const allocationLines = Object.entries(plan.allocation ?? {})
		.map(([k, v]) => `${k}: ${v.pct}%（${(v.products || []).join("、")}）`)
		.join("\n");
	const productLines = (plan.products || [])
		.map((p) => `- ${p.name}（${p.riskLevel}）：${p.reason}`)
		.join("\n");

	return [
		"客户经理刚刚敲定并采用了以下营销方案。请从该方案中提炼 1-2 条可复用的客户洞察，用于沉淀到客户画像。",
		"",
		"## 客户画像",
		"```json",
		JSON.stringify(
			{
				customerId: customer.customerId,
				name: customer.name,
				segment: customer.segment,
				riskTolerance: customer.riskTolerance,
				aum: customer.aum,
				lifeCycleStage: customer.lifeCycleStage,
				preferences: customer.preferences,
			},
			null,
			2,
		),
		"```",
		"",
		"## 被采用的方案",
		`标题：${plan.title}`,
		`评分：${plan.score}`,
		`诊断：${plan.diagnosis}`,
		`标签：${(plan.tags ?? []).join("、")}`,
		"配置比例：",
		allocationLines || "（无）",
		"推荐产品：",
		productLines || "（无）",
		"",
		"## 输出要求",
		'只输出一个 JSON 对象，结构为 { "content": "洞察文本（2-3句话，描述客户偏好/风险倾向/产品偏好/沟通风格等可复用特征）", "tags": ["标签1", "标签2"] }，不加解释或代码围栏。',
		"洞察应聚焦可复用的客户特征，而非方案本身的内容复述。",
	].join("\n");
}

/**
 * 构建沉淀个人知识库建议的 prompt。
 */
export function buildKnowledgeSuggestPrompt(
	customer: CustomerProfile,
	plan: MarketingPlan,
): string {
	const productLines = (plan.products || [])
		.map((p) => `- ${p.name}（${p.riskLevel}）：${p.reason}`)
		.join("\n");
	return [
		"客户经理刚刚敲定并采用了以下营销方案。请从该成功方案中提炼可沉淀到个人知识库的内容建议，供经理确认后写入。",
		"",
		"## 客户画像",
		`姓名：${customer.name}｜客群：${customer.segment}｜风险偏好：${customer.riskTolerance}｜AUM：${customer.aum}｜生命周期：${customer.lifeCycleStage}`,
		"",
		"## 被采用的方案",
		`标题：${plan.title}`,
		`诊断：${plan.diagnosis}`,
		"推荐产品：",
		productLines || "（无）",
		"企业微信话术：",
		plan.scripts?.wecom || "（无）",
		"",
		"## 输出要求",
		'只输出一个 JSON 对象，结构为 { "talkTemplates": "话术模板建议（开场/需求挖掘/跟进的可复用表达，可多条）", "productPriority": "产品优先度建议（产品或品类的推荐顺序与理由）", "stylePreference": "风格偏好建议（语气与表达风格）" }，不加解释或代码围栏。',
		"每段内容控制在 100 字以内，聚焦可复用经验，不复述方案细节。",
	].join("\n");
}