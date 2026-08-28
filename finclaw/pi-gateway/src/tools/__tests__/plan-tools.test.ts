import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import { executePlanTool } from "../plan-tools.ts";
import type { WorkflowDeps } from "../../workflow/types.ts";

function makeDeps(): WorkflowDeps & {
	backend: WorkflowDeps["backend"] & { fetchContext: Mock; audit: Mock };
	llm: WorkflowDeps["llm"] & { generatePlans: Mock };
} {
	return {
		backend: {
			fetchContext: vi.fn(),
			audit: vi.fn().mockResolvedValue({
				passed: true,
				riskMismatch: false,
				mismatchedProducts: [],
				offSaleProducts: [],
				forbiddenWords: [],
				missingRiskDisclosures: [],
				summary: "通过",
				markdown: "",
			}),
		},
		llm: { generatePlans: vi.fn() },
		retry: { buildRetryInstructions: vi.fn().mockReturnValue([]) },
	};
}

describe("executePlanTool(generate_plan)", () => {
	it("未传 context 时完整拉取并返回 GenerateResult", async () => {
		const deps = makeDeps();
		deps.backend.fetchContext.mockResolvedValue({
			customer: { customerId: "CUST_001", name: "张明远", riskTolerance: "C3", aum: 6800000 },
			products: [],
			strategies: [],
			personalKnowledge: "",
			marketBrief: "",
		});
		deps.llm.generatePlans.mockResolvedValue([
			{ planId: "plan-A", customerId: "CUST_001", title: "稳健配置", score: 90, tags: [], diagnosis: "", allocation: {}, products: [], scripts: { wecom: "", phone: [] }, markdown: "" },
		]);
		deps.backend.audit.mockResolvedValue({
			passed: true,
			riskMismatch: false,
			mismatchedProducts: [],
			offSaleProducts: [],
			forbiddenWords: [],
			missingRiskDisclosures: [],
			summary: "通过",
			markdown: "",
		});

		const out = await executePlanTool(
			{ customer_id: "CUST_001", manager_id: "MGR_001" },
			{},
			deps,
		);

		expect(out.details.success).toBe(true);
		expect(out.details.kind).toBe("generate_plan");
		const result = out.details.result as { plans: unknown[]; error?: string };
		expect(Array.isArray(result.plans)).toBe(true);
		expect(deps.backend.fetchContext).toHaveBeenCalledWith("CUST_001", "MGR_001");
		// 工具 content 只含摘要列表，不注入完整 JSON 围栏
		expect(out.content[0].text).toContain("方案 A");
		expect(out.content[0].text).not.toContain("```json");
	});

	it("提供 context 时不重新拉取", async () => {
		const deps = makeDeps();
		deps.llm.generatePlans.mockResolvedValue([
			{ planId: "plan-A", customerId: "CUST_001", title: "稳健配置", score: 90, tags: [], diagnosis: "", allocation: {}, products: [], scripts: { wecom: "", phone: [] }, markdown: "" },
		]);
		deps.backend.audit.mockResolvedValue({
			passed: true,
			riskMismatch: false,
			mismatchedProducts: [],
			offSaleProducts: [],
			forbiddenWords: [],
			missingRiskDisclosures: [],
			summary: "通过",
			markdown: "",
		});

		const out = await executePlanTool(
			{
				customer_id: "CUST_001",
				manager_id: "MGR_001",
				context: {
					customer_profile: { customerId: "CUST_001", name: "张明远", riskTolerance: "C3", aum: 6800000 },
					eligible_products: [],
					personal_knowledge: "偏好稳健",
				},
			},
			{},
			deps,
		);

		expect(out.details.success).toBe(true);
		expect(deps.backend.fetchContext).not.toHaveBeenCalled();
	});

	it("context 字段映射为新 spec 字段名(customer_profile/eligible_products/personal_knowledge/market_brief)", async () => {
		const deps = makeDeps();
		deps.llm.generatePlans.mockResolvedValue([
			{ planId: "plan-A", customerId: "CUST_001", title: "稳健配置", score: 90, tags: [], diagnosis: "", allocation: {}, products: [], scripts: { wecom: "", phone: [] }, markdown: "" },
		]);
		deps.backend.audit.mockResolvedValue({
			passed: true,
			riskMismatch: false,
			mismatchedProducts: [],
			offSaleProducts: [],
			forbiddenWords: [],
			missingRiskDisclosures: [],
			summary: "通过",
			markdown: "",
		});

		const out = await executePlanTool(
			{
				customer_id: "CUST_001",
				manager_id: "MGR_001",
				context: {
					customer_profile: { customerId: "CUST_001", name: "张明远", riskTolerance: "C3", aum: 6800000 },
					eligible_products: [{ productId: "P1", name: "稳健理财", category: "理财", riskLevel: "R2", reason: "" }],
					personal_knowledge: "偏好稳健",
					market_brief: "市场整体平稳，权益类短期震荡",
				},
			},
			{},
			deps,
		);

		expect(out.details.success).toBe(true);
		const generateContext = deps.llm.generatePlans.mock.calls[0][0].context;
		expect(generateContext.customer.customerId).toBe("CUST_001");
		expect(Array.isArray(generateContext.products)).toBe(true);
		expect(generateContext.products.length).toBe(1);
		expect(generateContext.personalKnowledge).toBe("偏好稳健");
		expect(generateContext.marketBrief).toBe("市场整体平稳，权益类短期震荡");
		expect(generateContext.strategies).toBeUndefined();
	});
});

describe("executePlanTool(optimize_plan)", () => {
	it("context 提供业务数据与目标方案时直接优化,不拉取 backend", async () => {
		const deps = makeDeps();
		const previousPlan = { planId: "plan-A", customerId: "CUST_001", title: "原方案", score: 80, tags: [], diagnosis: "", allocation: {}, products: [], scripts: { wecom: "", phone: [] }, markdown: "" };
		deps.llm.generatePlans.mockResolvedValue([
			{ ...previousPlan, title: "优化后方案", score: 92 },
		]);
		deps.backend.audit.mockResolvedValue({
			passed: true,
			riskMismatch: false,
			mismatchedProducts: [],
			offSaleProducts: [],
			forbiddenWords: [],
			missingRiskDisclosures: [],
			summary: "通过",
			markdown: "",
		});

		const out = await executePlanTool(
			{
				customer_id: "CUST_001",
				manager_id: "MGR_001",
				target_plan_id: "plan-A",
				instruction: "把权益比例降低到 20%",
				context: {
					customer_profile: { customerId: "CUST_001", name: "张明远", riskTolerance: "C3", aum: 6800000 },
					eligible_products: [],
					previous_plans: [previousPlan],
				},
			},
			{},
			deps,
		);

		expect(out.details.success).toBe(true);
		expect(out.details.kind).toBe("optimize_plan");
		// 业务上下文已提供,不应拉取 backend
		expect(deps.backend.fetchContext).not.toHaveBeenCalled();
	});

	it("风控闸门错误返回 error", async () => {
		const deps = makeDeps();
		deps.backend.fetchContext.mockResolvedValue({
			customer: { customerId: "CUST_001", name: "张明远", riskTolerance: "", aum: 0 },
			products: [],
			strategies: [],
			personalKnowledge: "",
			marketBrief: "",
		});
		deps.llm.generatePlans.mockResolvedValue([]);

		const out = await executePlanTool(
			{ customer_id: "CUST_001", manager_id: "MGR_001" },
			{},
			deps,
		);

		expect(out.details.success).toBe(false);
		expect(String(out.details.error)).toContain("风险承受能力");
	});
});

describe("executePlanTool 系统异常隔离", () => {
	it("LLM 抛出内部异常时,content 为友好提示且不泄露原始错误细节", async () => {
		const deps = makeDeps();
		deps.backend.fetchContext.mockResolvedValue({
			customer: { customerId: "CUST_001", name: "张明远", riskTolerance: "C3", aum: 6800000 },
			products: [],
			strategies: [],
			personalKnowledge: "",
			marketBrief: "",
		});
		deps.llm.generatePlans.mockRejectedValue(
			new Error("LLM 叶子节点未返回可识别的方案 JSON: 解析失败。原始输出前 200 字符: {...}"),
		);

		const out = await executePlanTool(
			{ customer_id: "CUST_001", manager_id: "MGR_001" },
			{},
			deps,
		);

		expect(out.details.success).toBe(false);
		// 用户可见 content 只含友好提示
		expect(out.content[0].text).toBe("方案生成未能完成，请稍后重试。");
		expect(out.content[0].text).not.toContain("JSON");
		expect(out.content[0].text).not.toContain("原始输出");
		expect(out.content[0].text).not.toContain("LLM 叶子节点");
		// 原始错误保留在 details 供排查
		expect(String(out.details.error)).toContain("LLM 叶子节点未返回可识别的方案 JSON");
	});
});
