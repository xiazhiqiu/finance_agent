import { describe, it, expect } from "vitest";
import { buildRetryInstructions } from "../retry-context.ts";
import type { MarketingPlan, ComplianceReport } from "../types.ts";

function makePlan(planId: string, title: string, productIds: string[] = []): MarketingPlan {
	return {
		planId,
		customerId: "CUST_001",
		title,
		score: 90,
		tags: [],
		diagnosis: "",
		allocation: {},
		products: productIds.map((pid) => ({
			productId: pid,
			name: `产品${pid}`,
			category: "理财",
			riskLevel: "R2",
			reason: "",
		})),
		scripts: { wecom: "", phone: [] },
		markdown: "",
	};
}

function makeReport(overrides: Partial<ComplianceReport> = {}): ComplianceReport {
	return {
		passed: false,
		riskMismatch: false,
		mismatchedProducts: [],
		offSaleProducts: [],
		forbiddenWords: [],
		missingRiskDisclosures: [],
		summary: "存在合规问题",
		markdown: "",
		...overrides,
	};
}

describe("buildRetryInstructions", () => {
	it("passed === true 时返回空数组", () => {
		const plans = [makePlan("plan-A", "方案A")];
		const report = makeReport({ passed: true });
		expect(buildRetryInstructions(plans, report)).toEqual([]);
	});

	describe("mismatchedProduct", () => {
		it("按 productId 定位到包含该产品的 plan", () => {
			const plans = [
				makePlan("plan-A", "方案A", ["P001", "P002"]),
				makePlan("plan-B", "方案B", ["P003"]),
			];
			const report = makeReport({
				mismatchedProducts: [
					{ productId: "P001", name: "产品P001", reason: "产品风险等级 R4 高于客户承受等级 C3" },
				],
			});
			const result = buildRetryInstructions(plans, report);
			expect(result).toHaveLength(1);
			expect(result[0].planId).toBe("plan-A");
			expect(result[0].issues).toHaveLength(1);
			expect(result[0].issues[0]).toMatchObject({
				type: "mismatchedProduct",
				productId: "P001",
				productName: "产品P001",
				detail: "产品风险等级 R4 高于客户承受等级 C3",
				fixSuggestion: "从上下文 products 列表中重新选择风险等级 ≤ 客户承受等级的产品替换",
			});
		});

		it("同一 productId 出现在多个 plan 时全部命中", () => {
			const plans = [
				makePlan("plan-A", "方案A", ["P001"]),
				makePlan("plan-B", "方案B", ["P001"]),
			];
			const report = makeReport({
				mismatchedProducts: [
					{ productId: "P001", name: "产品P001", reason: "风险错配" },
				],
			});
			const result = buildRetryInstructions(plans, report);
			expect(result).toHaveLength(2);
			expect(result[0].planId).toBe("plan-A");
			expect(result[1].planId).toBe("plan-B");
		});
	});

	describe("offSaleProduct", () => {
		it("reason=产品不存在 时给出 productId 核对建议", () => {
			const plans = [makePlan("plan-A", "方案A", ["P001"])];
			const report = makeReport({
				offSaleProducts: [
					{ productId: "P001", name: "产品P001", reason: "产品不存在" },
				],
			});
			const result = buildRetryInstructions(plans, report);
			expect(result[0].issues[0]).toMatchObject({
				type: "offSaleProduct",
				detail: "产品不存在",
				fixSuggestion: "productId 可能有误，请回上下文 products 列表确认正确的 productId",
			});
		});

		it("reason=产品已下架 时给出替换建议", () => {
			const plans = [makePlan("plan-A", "方案A", ["P001"])];
			const report = makeReport({
				offSaleProducts: [
					{ productId: "P001", name: "产品P001", reason: "产品已下架" },
				],
			});
			const result = buildRetryInstructions(plans, report);
			expect(result[0].issues[0].fixSuggestion).toBe("从上下文 products 列表中选择其他在售产品替换");
		});

		it("reason=产品配额不足 时给出配额替换建议", () => {
			const plans = [makePlan("plan-A", "方案A", ["P001"])];
			const report = makeReport({
				offSaleProducts: [
					{ productId: "P001", name: "产品P001", reason: "产品配额不足" },
				],
			});
			const result = buildRetryInstructions(plans, report);
			expect(result[0].issues[0].fixSuggestion).toBe("从上下文 products 列表中选择有配额的在售产品替换");
		});

		it("reason 为其他值时给出默认替换建议", () => {
			const plans = [makePlan("plan-A", "方案A", ["P001"])];
			const report = makeReport({
				offSaleProducts: [
					{ productId: "P001", name: "产品P001", reason: "未知原因" },
				],
			});
			const result = buildRetryInstructions(plans, report);
			expect(result[0].issues[0].fixSuggestion).toBe("从上下文 products 列表中选择其他在售产品替换");
		});
	});

	describe("forbiddenWord", () => {
		it("context 与 plan.title 精确匹配时只命中该 plan", () => {
			const plans = [
				makePlan("plan-A", "稳健方案"),
				makePlan("plan-B", "进取方案"),
			];
			const report = makeReport({
				forbiddenWords: [
					{ word: "保本保收益", context: "稳健方案", suggestion: "" },
				],
			});
			const result = buildRetryInstructions(plans, report);
			expect(result).toHaveLength(1);
			expect(result[0].planId).toBe("plan-A");
			expect(result[0].issues[0]).toMatchObject({
				type: "forbiddenWord",
				detail: `方案话术或 markdown 中包含违禁词"保本保收益"`,
			});
		});

		it("context 与所有 plan.title 都不匹配时广播到所有 plan", () => {
			const plans = [
				makePlan("plan-A", "稳健方案"),
				makePlan("plan-B", "进取方案"),
			];
			const report = makeReport({
				forbiddenWords: [
					{ word: "零风险", context: "不存在的标题", suggestion: "" },
				],
			});
			const result = buildRetryInstructions(plans, report);
			expect(result).toHaveLength(2);
			expect(result[0].planId).toBe("plan-A");
			expect(result[1].planId).toBe("plan-B");
		});
	});

	describe("missingRiskDisclosure", () => {
		it("去后缀后按 title 精确匹配", () => {
			const plans = [
				makePlan("plan-A", "稳健方案"),
				makePlan("plan-B", "进取方案"),
			];
			const report = makeReport({
				missingRiskDisclosures: ["稳健方案 缺少必要风险提示"],
			});
			const result = buildRetryInstructions(plans, report);
			expect(result).toHaveLength(1);
			expect(result[0].planId).toBe("plan-A");
			expect(result[0].issues[0]).toMatchObject({
				type: "missingRiskDisclosure",
				detail: "方案 markdown 缺少必要风险揭示语",
			});
		});

		it("去后缀后 title 不匹配任何 plan 时广播", () => {
			const plans = [makePlan("plan-A", "稳健方案")];
			const report = makeReport({
				missingRiskDisclosures: ["未知方案 缺少必要风险提示"],
			});
			const result = buildRetryInstructions(plans, report);
			expect(result).toHaveLength(1);
			expect(result[0].planId).toBe("plan-A");
		});

		it("disclosure 字符串不含后缀时整串作为 planTitle 匹配", () => {
			const plans = [makePlan("plan-A", "方案markdown缺失提示")];
			const report = makeReport({
				missingRiskDisclosures: ["方案markdown缺失提示"],
			});
			const result = buildRetryInstructions(plans, report);
			expect(result).toHaveLength(1);
			expect(result[0].planId).toBe("plan-A");
		});
	});

	describe("多类型 issue 累积", () => {
		it("同一 plan 累积多个不同类型 issue", () => {
			const plans = [makePlan("plan-A", "方案A", ["P001"])];
			const report = makeReport({
				mismatchedProducts: [
					{ productId: "P001", name: "产品P001", reason: "风险错配" },
				],
				forbiddenWords: [
					{ word: "稳赚不赔", context: "方案A", suggestion: "" },
				],
				missingRiskDisclosures: ["方案A 缺少必要风险提示"],
			});
			const result = buildRetryInstructions(plans, report);
			expect(result).toHaveLength(1);
			expect(result[0].issues).toHaveLength(3);
			const types = result[0].issues.map((i) => i.type);
			expect(types).toEqual(
				expect.arrayContaining(["mismatchedProduct", "forbiddenWord", "missingRiskDisclosure"]),
			);
		});

		it("无 issue 的 plan 不出现在结果中", () => {
			const plans = [
				makePlan("plan-A", "方案A", ["P001"]),
				makePlan("plan-B", "方案B", ["P002"]),
			];
			const report = makeReport({
				mismatchedProducts: [
					{ productId: "P001", name: "产品P001", reason: "风险错配" },
				],
			});
			const result = buildRetryInstructions(plans, report);
			expect(result).toHaveLength(1);
			expect(result[0].planId).toBe("plan-A");
		});
	});
});
