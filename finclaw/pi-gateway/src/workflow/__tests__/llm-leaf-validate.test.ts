import { describe, it, expect } from "vitest";
import { backfillPlanFields, validatePlan } from "../llm-leaf.ts";
import type { MarketingPlan, Product } from "../types.ts";

const contextProducts: Product[] = [
	{
		productId: "P001",
		name: "稳健理财1号",
		category: "理财",
		subCategory: "固收类",
		riskLevel: "R2",
		minAmount: 10000,
		availableQuota: 500000,
		onSale: true,
		tenor: "180天",
		expectedReturn: "3.2%",
		campaigns: [],
	},
];

/** A1: LLM 输出精简结构(仅 productId + reason) */
function makePlan(overrides: Record<string, unknown> = {}): MarketingPlan {
	return {
		planId: "plan-A",
		customerId: "CUST_001",
		title: "稳健配置",
		score: 90,
		tags: ["稳健"],
		diagnosis: "【资产配置】… | 【风险诊断】… | 【任务诊断】…",
		allocation: { "固收理财": { pct: 70, products: ["稳健理财1号"] } },
		products: [{ productId: "P001", reason: "匹配" }],
		scripts: { wecom: "话术", phone: ["话术"] },
		markdown: "## 客户诊断\n\n理财有风险，投资需谨慎",
		...overrides,
	} as unknown as MarketingPlan;
}

describe("validatePlan allocation 结构校验", () => {
	it("合法 allocation(类别值为 { pct, products } 对象)通过", () => {
		expect(() => validatePlan(makePlan(), contextProducts)).not.toThrow();
	});

	it("allocation 类别值平铺为数字时抛错(如 { \"固收理财\": 45, \"pct\": 55, \"products\": [...] })", () => {
		const plan = makePlan({
			allocation: { "固收理财": 45, pct: 55, products: ["稳健理财1号"] },
		});
		expect(() => validatePlan(plan, contextProducts)).toThrow("allocation.固收理财 必须是 { pct, products } 对象");
	});

	it("allocation 类别值缺 pct 时抛错", () => {
		const plan = makePlan({
			allocation: { "固收理财": { products: ["稳健理财1号"] } },
		});
		expect(() => validatePlan(plan, contextProducts)).toThrow("allocation.固收理财.pct 必须是数字");
	});

	it("allocation 类别值 products 非数组时抛错", () => {
		const plan = makePlan({
			allocation: { "固收理财": { pct: 70, products: "稳健理财1号" } },
		});
		expect(() => validatePlan(plan, contextProducts)).toThrow("allocation.固收理财.products 必须是字符串数组");
	});

	it("allocation 非对象时抛错", () => {
		const plan = makePlan({ allocation: "70%" });
		expect(() => validatePlan(plan, contextProducts)).toThrow("allocation 必须是对象");
	});
});

describe("validatePlan products 精简输出校验(A1)", () => {
	it("products 项缺 reason 时抛错", () => {
		const plan = makePlan({ products: [{ productId: "P001" }] });
		expect(() => validatePlan(plan, contextProducts)).toThrow("缺推荐理由(reason)");
	});

	it("products 项 productId 不在上下文集合时抛错", () => {
		const plan = makePlan({ products: [{ productId: "P999", reason: "x" }] });
		expect(() => validatePlan(plan, contextProducts)).toThrow("productId 不在上下文产品范围内");
	});
});

describe("backfillPlanFields(A1/A3 程序回填)", () => {
	it("按 productId 回填展示字段,allocation 名称统一为标准名称", () => {
		const plan = makePlan();
		backfillPlanFields(plan, contextProducts);
		expect(plan.products[0]).toEqual({
			productId: "P001",
			name: "稳健理财1号",
			category: "理财",
			subCategory: "固收类",
			riskLevel: "R2",
			tenor: "180天",
			expectedReturn: "3.2%",
			reason: "匹配",
		});
		expect(plan.allocation["固收理财"].products).toEqual(["稳健理财1号"]);
	});

	it("allocation.products 名称未命中回填集合时抛错", () => {
		const plan = makePlan({
			allocation: { "固收理财": { pct: 70, products: ["不存在的产品"] } },
		});
		expect(() => backfillPlanFields(plan, contextProducts)).toThrow("含未选产品名");
	});
});
