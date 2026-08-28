import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLlmLeaf } from "../llm-leaf.ts";
import { runLlmJsonOnce } from "../llm-json.ts";
import type { GenerateParams, Product } from "../types.ts";

vi.mock("../llm-json.ts", () => ({
	runLlmJsonOnce: vi.fn(),
}));

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
	{
		productId: "P002",
		name: "进取基金",
		category: "基金",
		subCategory: "权益类",
		riskLevel: "R4",
		minAmount: 10000,
		availableQuota: 500000,
		onSale: true,
		tenor: "长期",
		expectedReturn: "6%",
		campaigns: [],
	},
];

const baseContext = {
	customer: { customerId: "CUST_001", name: "张明远", riskTolerance: "C3", aum: 6800000 },
	products: contextProducts,
	strategies: [],
	personalKnowledge: "",
};

const validPlan = {
	planId: "plan-A",
	customerId: "CUST_001",
	title: "稳健配置",
	score: 90,
	tags: ["稳健"],
	diagnosis: "【资产配置】… | 【风险诊断】… | 【任务诊断】…",
	allocation: { 固收理财: { pct: 70, products: ["稳健理财1号"] } },
	products: [{ productId: "P001", reason: "匹配" }],
	scripts: { wecom: "话术", phone: ["话术"] },
	markdown: "理财有风险，投资需谨慎",
};

const validJson = JSON.stringify({ plans: [validPlan] });

function makeParams(overrides: Partial<GenerateParams> = {}): GenerateParams {
	return {
		context: baseContext,
		mode: "generate",
		...overrides,
	};
}

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "llm-leaf-retry-"));
	writeFileSync(join(tmpDir, "AGENTS.md"), "你是营销方案生成器", "utf-8");
	vi.mocked(runLlmJsonOnce).mockReset();
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

function createLeaf() {
	return createLlmLeaf(tmpDir, join(tmpDir, "AGENTS.md"));
}

describe("generatePlans 错误反馈重试(P0)", () => {
	it("首次即成功:仅调用 1 次,无重试反馈", async () => {
		vi.mocked(runLlmJsonOnce).mockResolvedValue({ rawText: validJson, parsed: undefined });
		const leaf = createLeaf();

		const plans = await leaf.generatePlans(makeParams());

		expect(plans).toHaveLength(1);
		expect(plans[0].planId).toBe("plan-A");
		expect(runLlmJsonOnce).toHaveBeenCalledTimes(1);
	});

	it("首次校验失败(缺字段)后,自动带错误反馈重试并成功", async () => {
		// 首次:合法 JSON 但 plan 缺 title 字段,触发 validatePlan 抛错
		const brokenPlan = { ...validPlan };
		delete (brokenPlan as Record<string, unknown>).title;
		const brokenJson = JSON.stringify({ plans: [brokenPlan] });

		vi.mocked(runLlmJsonOnce)
			.mockResolvedValueOnce({ rawText: brokenJson, parsed: undefined })
			.mockResolvedValueOnce({ rawText: validJson, parsed: undefined });
		const leaf = createLeaf();

		const plans = await leaf.generatePlans(makeParams());

		expect(plans).toHaveLength(1);
		expect(runLlmJsonOnce).toHaveBeenCalledTimes(2);
		// 第二次调用必须携带"输出格式修正"反馈,且含具体错误信息
		const secondPrompt = vi.mocked(runLlmJsonOnce).mock.calls[1][2];
		expect(secondPrompt).toContain("## 输出格式修正");
		expect(secondPrompt).toContain("方案缺字段: title");
	});

	it("首次一致性校验失败(allocation 含未选产品名)后重试成功", async () => {
		const badAlloc = JSON.stringify({
			plans: [
				{
					...validPlan,
					allocation: { 固收理财: { pct: 70, products: ["不存在的产品"] } },
				},
			],
		});

		vi.mocked(runLlmJsonOnce)
			.mockResolvedValueOnce({ rawText: badAlloc, parsed: undefined })
			.mockResolvedValueOnce({ rawText: validJson, parsed: undefined });
		const leaf = createLeaf();

		const plans = await leaf.generatePlans(makeParams());

		expect(plans).toHaveLength(1);
		expect(runLlmJsonOnce).toHaveBeenCalledTimes(2);
		expect(vi.mocked(runLlmJsonOnce).mock.calls[1][2]).toContain("含未选产品名");
	});

	it("两次均失败:抛出最后一次错误,共调用 2 次", async () => {
		const brokenPlan = { ...validPlan };
		delete (brokenPlan as Record<string, unknown>).title;
		const brokenJson = JSON.stringify({ plans: [brokenPlan] });

		vi.mocked(runLlmJsonOnce)
			.mockResolvedValue({ rawText: brokenJson, parsed: undefined });
		const leaf = createLeaf();

		await expect(leaf.generatePlans(makeParams())).rejects.toThrow("方案缺字段: title");
		expect(runLlmJsonOnce).toHaveBeenCalledTimes(2);
	});
});

describe("parsePlansFromText 启发式 JSON 修复(P1)", () => {
	it("缺逗号 JSON 在首轮即被修复,无需二次重试", async () => {
		// products 数组元素间缺逗号:{"productId":"P001","reason":"r"} {"productId":"P002"...}
		const missingCommaJson =
			'{"plans":[{"planId":"plan-A","customerId":"CUST_001","title":"t","score":90,' +
			'"tags":[],"diagnosis":"d","allocation":{"固收":{"pct":70,"products":["稳健理财1号"]}},' +
			'"products":[{"productId":"P001","reason":"r"} {"productId":"P002","reason":"r"}],' +
			'"scripts":{"wecom":"w","phone":["p"]},"markdown":"理财有风险，投资需谨慎"}]}';

		vi.mocked(runLlmJsonOnce).mockResolvedValue({ rawText: missingCommaJson, parsed: undefined });
		const leaf = createLeaf();

		const plans = await leaf.generatePlans(makeParams());

		expect(plans).toHaveLength(1);
		expect(plans[0].products.map((p) => p.productId)).toEqual(["P001", "P002"]);
		// 首轮即修复成功,不应触发重试
		expect(runLlmJsonOnce).toHaveBeenCalledTimes(1);
	});
});
