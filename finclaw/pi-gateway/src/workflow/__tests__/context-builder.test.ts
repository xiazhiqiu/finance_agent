import { describe, it, expect } from "vitest";
import {
	projectPlanContext,
	serializeLeafContext,
	buildChatStablePrefix,
} from "../context-builder.ts";
import type { CustomerProfile, CustomerTask, Product, WorkflowContext } from "../types.ts";

function makeCustomer(): CustomerProfile & { tasks?: unknown } {
	return {
		customerId: "CUST_001",
		name: "张明远",
		segment: "高净值",
		riskTolerance: "C3",
		aum: 6800000,
		tasks: [{ strategyName: "到期资金承接" }],
	};
}

function makeProduct(): Product {
	return {
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
		campaigns: ["新客专享"],
		description: "稳健型固收理财产品，主投高等级信用债，历史业绩稳定，适合稳健型客户长期持有，兼顾流动性与收益。".repeat(2),
		benchmark: "中债综合财富指数",
		returns: { m1: 0.2, m6: 1.6, y1: 3.2 },
		marketTags: ["稳健", "固收"],
		scriptTemplate: "{{name}}您好，本产品主投高等级信用债，适合作为底仓配置，欢迎咨询详情。".repeat(2),
		highlights: ["风险可控", "收益稳定"],
	};
}

function makeTask(): CustomerTask {
	return {
		taskId: "T1",
		customerId: "CUST_001",
		strategyType: "maturity",
		strategyName: "到期资金承接",
		category: "资产事件",
		priority: 100,
		triggerCondition: "三年定期 ¥800,000 将于 2026-09-10 到期",
		status: "pending",
		source: "rule",
		createdAt: "2026-08-18T01:35:11.818Z",
	};
}

function makeContext(overrides: Partial<WorkflowContext> = {}): WorkflowContext {
	return {
		customer: makeCustomer(),
		products: [makeProduct()],
		strategies: [makeTask()],
		personalKnowledge: "偏好稳健,厌恶回撤",
		marketBrief: "市场整体平稳",
		...overrides,
	};
}

describe("projectPlanContext", () => {
	it("白名单投影:保留 strategies 任务与产品全字段,剔除配额/在售字段与 customer.tasks", () => {
		const result = projectPlanContext(makeContext());
		expect(result.strategies).toEqual([makeTask()]);
		// B4: customer.tasks 已由 strategies 承载,投影时剔除
		expect(result.customer).not.toHaveProperty("tasks");
		expect(result.customer.customerId).toBe("CUST_001");
		expect(result.personalKnowledge).toBe("偏好稳健,厌恶回撤");
		expect(result.marketBrief).toBe("市场整体平稳");
		expect(result.products).toHaveLength(1);
		expect(Object.keys(result.products[0]).sort()).toEqual(
			[
				"benchmark",
				"category",
				"description",
				"expectedReturn",
				"highlights",
				"marketTags",
				"name",
				"productId",
				"returns",
				"riskLevel",
				"scriptTemplate",
				"subCategory",
				"tenor",
			].sort(),
		);
		expect(result.products[0]).not.toHaveProperty("minAmount");
		expect(result.products[0]).not.toHaveProperty("availableQuota");
		expect(result.products[0]).not.toHaveProperty("onSale");
		expect(result.products[0]).not.toHaveProperty("campaigns");
	});

	it("strategies 为空数组时不输出该键", () => {
		const result = projectPlanContext(makeContext({ strategies: [] }));
		expect("strategies" in result).toBe(false);
	});

	it("marketBrief 为空字符串时键不出现", () => {
		const result = projectPlanContext(makeContext({ marketBrief: "" }));
		expect("marketBrief" in result).toBe(false);
	});

	it("customer 缺省时抛错", () => {
		expect(() => projectPlanContext({ products: [] })).toThrow("plan scope 缺少客户画像");
	});
});

describe("serializeLeafContext", () => {
	it("输出为紧凑 JSON,不含换行", () => {
		const json = serializeLeafContext(projectPlanContext(makeContext()));
		expect(json).not.toContain("\n");
		expect(JSON.parse(json).customer.customerId).toBe("CUST_001");
	});

	it("products 以扁平表格字符串注入(B1:键名只出现一次)", () => {
		const parsed = JSON.parse(serializeLeafContext(projectPlanContext(makeContext())));
		expect(typeof parsed.products).toBe("string");
		expect(parsed.products).toContain("products 候选表");
		expect(parsed.products).toContain("productId|name|category|subCategory");
		expect(parsed.products).toContain("P001|稳健理财1号");
		// 长文本截断(B2)
		expect(parsed.products).not.toContain("{{name}}您好，本产品主投高等级信用债。");
		expect(parsed.products).toContain("…");
	});

	it("预算内输入不裁剪", () => {
		const leaf = projectPlanContext(makeContext());
		const parsed = JSON.parse(serializeLeafContext(leaf));
		expect(parsed.personalKnowledge).toBe("偏好稳健,厌恶回撤");
		expect(parsed.marketBrief).toBe("市场整体平稳");
	});

	it("超预算时裁剪 personalKnowledge 且不改入参", () => {
		// 预算 4000 token:24000 字 ≈ 6000 token 触发裁剪,截半 12000 字 ≈ 3000 token 停止
		const longKnowledge = "知".repeat(24000);
		const leaf = projectPlanContext(makeContext({ personalKnowledge: longKnowledge }));
		const parsed = JSON.parse(serializeLeafContext(leaf));
		// 超预算 → 截半(24000 → 12000),仍预算内则停止
		expect(parsed.personalKnowledge.length).toBe(12000);
		expect(parsed.personalKnowledge.length).toBeLessThan(longKnowledge.length);
		// 入参未被修改
		expect(leaf.personalKnowledge).toBe(longKnowledge);
	});
});

describe("buildChatStablePrefix", () => {
	it("输出含标题头与尾行提示", () => {
		const out = buildChatStablePrefix({ managerId: "MGR_001" });
		expect(out).toContain("## 会话业务上下文");
		expect(out).toContain("以上为该会话的长期业务背景，回答时可参考，无需向用户复述。");
	});

	it("summary 为空时输出「暂无」,managerId 缺省输出 null", () => {
		const out = buildChatStablePrefix({ summary: "" });
		const line = out.split("\n")[1];
		const parsed = JSON.parse(line);
		expect(parsed.summary).toBe("暂无");
		expect(parsed.managerId).toBeNull();
		expect(Object.keys(parsed)).toEqual(["managerId", "customer", "summary", "knowledge"]);
	});

	it("customer 缺省时输出 null,knowledge 超 300 字被截断", () => {
		const out = buildChatStablePrefix({
			managerId: "MGR_001",
			customer: null,
			summary: "偏好稳健",
			knowledge: "知".repeat(500),
		});
		const parsed = JSON.parse(out.split("\n")[1]);
		expect(parsed.customer).toBeNull();
		expect(parsed.knowledge.length).toBe(300);
		expect(parsed.summary).toBe("偏好稳健");
	});

	it("customer 白名单字段按固定顺序输出", () => {
		const out = buildChatStablePrefix({
			customer: {
				customerId: "CUST_001",
				name: "张明远",
				segment: "高净值",
				riskTolerance: "C3",
				aum: 6800000,
			},
		});
		const parsed = JSON.parse(out.split("\n")[1]);
		expect(Object.keys(parsed.customer)).toEqual([
			"customerId",
			"name",
			"segment",
			"riskTolerance",
			"aum",
		]);
	});
});
