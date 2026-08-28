/**
 * retry 修正指令构造(纯函数)
 *
 * 移植自 .pi/skills/compliance-auditor/scripts/retry-context.mjs,逐字保留
 * 4 类 issue 的定位规则与 fixSuggestion 文案。输入上轮生成的方案与合规
 * 审查报告,输出按 planId 维度组织的修正指令,作为下一轮 LLM 生成的
 * 明确依据。report.passed === true 时返回空数组。
 */

import type {
	ComplianceReport,
	MarketingPlan,
	RetryInstruction,
} from "./types.ts";

/**
 * 构建结构化修正指令。完全纯函数,无 IO。
 */
export function buildRetryInstructions(
	plans: MarketingPlan[],
	report: ComplianceReport,
): RetryInstruction[] {
	// 合规已通过,无需修正
	if (report.passed) return [];

	const planIssuesMap = new Map<string, RetryInstruction>();

	function ensurePlanEntry(plan: MarketingPlan): RetryInstruction {
		let entry = planIssuesMap.get(plan.planId);
		if (!entry) {
			entry = { planId: plan.planId, title: plan.title, issues: [] };
			planIssuesMap.set(plan.planId, entry);
		}
		return entry;
	}

	function planHasProduct(plan: MarketingPlan, productId: string): boolean {
		return (
			Array.isArray(plan.products) &&
			plan.products.some((p) => p.productId === productId)
		);
	}

	// 1. mismatchedProducts: 按 productId 定位所属 plan
	const mismatchedProducts = Array.isArray(report.mismatchedProducts)
		? report.mismatchedProducts
		: [];
	for (const item of mismatchedProducts) {
		const { productId, name, reason } = item;
		for (const plan of plans) {
			if (planHasProduct(plan, productId)) {
				const entry = ensurePlanEntry(plan);
				entry.issues.push({
					type: "mismatchedProduct",
					productId,
					productName: name,
					detail: reason,
					fixSuggestion:
						"从上下文 products 列表中重新选择风险等级 ≤ 客户承受等级的产品替换",
				});
			}
		}
	}

	// 2. offSaleProducts: 按 productId 定位,根据 reason 给修正建议
	const offSaleProducts = Array.isArray(report.offSaleProducts)
		? report.offSaleProducts
		: [];
	for (const item of offSaleProducts) {
		const { productId, name, reason } = item;
		let fixSuggestion: string;
		if (reason === "产品不存在") {
			fixSuggestion = "productId 可能有误，请回上下文 products 列表确认正确的 productId";
		} else if (reason === "产品已下架") {
			fixSuggestion = "从上下文 products 列表中选择其他在售产品替换";
		} else if (reason === "产品配额不足") {
			fixSuggestion = "从上下文 products 列表中选择有配额的在售产品替换";
		} else {
			fixSuggestion = "从上下文 products 列表中选择其他在售产品替换";
		}
		for (const plan of plans) {
			if (planHasProduct(plan, productId)) {
				const entry = ensurePlanEntry(plan);
				entry.issues.push({
					type: "offSaleProduct",
					productId,
					productName: name,
					detail: reason,
					fixSuggestion,
				});
			}
		}
	}

	// 3. forbiddenWords: context 即 plan.title,先按 title 精确匹配;
	//    匹配失败则广播到所有 plan
	const forbiddenWords = Array.isArray(report.forbiddenWords)
		? report.forbiddenWords
		: [];
	for (const item of forbiddenWords) {
		const { word, context } = item;
		const matched = plans.filter((plan) => plan.title === context);
		const targets = matched.length > 0 ? matched : plans;
		for (const plan of targets) {
			const entry = ensurePlanEntry(plan);
			entry.issues.push({
				type: "forbiddenWord",
				detail: `方案话术或 markdown 中包含违禁词"${word}"`,
				fixSuggestion:
					`删除该违禁词，若因产品名含违禁词（如"绝对收益"），改用 productId 或去违禁词的简称引用`,
			});
		}
	}

	// 4. missingRiskDisclosures: 字符串格式 "${plan.title} 缺少必要风险提示"
	//    去掉后缀后先按 title 精确匹配;匹配失败广播到所有 plan
	const missingRiskDisclosures = Array.isArray(report.missingRiskDisclosures)
		? report.missingRiskDisclosures
		: [];
	const disclosureSuffix = " 缺少必要风险提示";
	for (const disclosure of missingRiskDisclosures) {
		if (typeof disclosure !== "string") continue;
		const planTitle = disclosure.endsWith(disclosureSuffix)
			? disclosure.slice(0, -disclosureSuffix.length)
			: disclosure;
		const matched = plans.filter((plan) => plan.title === planTitle);
		const targets = matched.length > 0 ? matched : plans;
		for (const plan of targets) {
			const entry = ensurePlanEntry(plan);
			entry.issues.push({
				type: "missingRiskDisclosure",
				detail: "方案 markdown 缺少必要风险揭示语",
				fixSuggestion:
					"在 markdown 中追加以下两句之一（逐字匹配）：'理财有风险，投资需谨慎' 或 '基金过往业绩不预示未来表现'",
			});
		}
	}

	return Array.from(planIssuesMap.values()).filter((p) => p.issues.length > 0);
}
