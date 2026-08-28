import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import { runGeneratePlan, runOptimizePlan } from "../orchestrator.ts";
import type {
	BackendClient,
	ComplianceReport,
	LlmLeaf,
	MarketingPlan,
	RetryBuilder,
	WorkflowContext,
	WorkflowDeps,
	WorkflowRequest,
} from "../types.ts";

// ========== 测试数据 ==========

function makeCustomer(riskTolerance = "C3") {
	return {
		customerId: "CUST_001",
		name: "张明远",
		riskTolerance,
		aum: 6800000,
	};
}

function makeProducts(): MarketingPlan["products"] {
	return [
		{ productId: "P001", name: "稳健理财", category: "理财", riskLevel: "R2", reason: "" },
		{ productId: "P002", name: "进取基金", category: "基金", riskLevel: "R4", reason: "" },
	];
}

function makeContext(riskTolerance = "C3"): WorkflowContext {
	return {
		customer: makeCustomer(riskTolerance) as WorkflowContext["customer"],
		products: [
			{ productId: "P001", name: "稳健理财", category: "理财", riskLevel: "R2", minAmount: 0, availableQuota: 10, onSale: true, tenor: "", expectedReturn: "", campaigns: [] },
			{ productId: "P002", name: "进取基金", category: "基金", riskLevel: "R4", minAmount: 0, availableQuota: 10, onSale: true, tenor: "", expectedReturn: "", campaigns: [] },
		],
		strategies: [],
		personalKnowledge: "",
	};
}

function makePlan(planId: string, title = `方案${planId}`): MarketingPlan {
	return {
		planId,
		customerId: "CUST_001",
		title,
		score: 90,
		tags: [],
		diagnosis: "",
		allocation: {},
		products: [{ productId: "P001", name: "稳健理财", category: "理财", riskLevel: "R2", reason: "" }],
		scripts: { wecom: "", phone: [] },
		markdown: "理财有风险，投资需谨慎",
	};
}

function makeReport(passed: boolean, overrides: Partial<ComplianceReport> = {}): ComplianceReport {
	return {
		passed,
		riskMismatch: false,
		mismatchedProducts: [],
		offSaleProducts: [],
		forbiddenWords: [],
		missingRiskDisclosures: [],
		summary: passed ? "全部方案通过合规审查" : "存在合规问题",
		markdown: "",
		...overrides,
	};
}

function makeRequest(action: "generate_plans" | "optimize_plan" = "generate_plans", overrides: Partial<WorkflowRequest["payload"]> = {}): WorkflowRequest {
	return {
		action,
		payload: {
			customer_id: "CUST_001",
			manager_id: "manager-local",
			...overrides,
		},
	};
}

interface MockDeps {
	backend: BackendClient & {
		fetchContext: Mock;
		audit: Mock;
	};
	llm: LlmLeaf & { generatePlans: Mock };
	retry: RetryBuilder & { buildRetryInstructions: Mock };
	maxAttempts?: number;
}

function makeMockDeps(): MockDeps {
	return {
		backend: {
			fetchContext: vi.fn(),
			audit: vi.fn(),
		},
		llm: {
			generatePlans: vi.fn(),
		},
		retry: {
			buildRetryInstructions: vi.fn().mockReturnValue([]),
		},
	};
}

// ========== generate_plans 测试 ==========

describe("runGeneratePlan", () => {
	it("风控闸门:riskTolerance 为空时不调 LLM 与 audit", async () => {
		const deps = makeMockDeps();
		deps.backend.fetchContext.mockResolvedValue(makeContext(""));
		const req = makeRequest();

		const result = await runGeneratePlan(req, deps);

		expect(result).toEqual({
			plans: [],
			error: "客户风险承受能力未评估，请先完成风险评估后再生成方案",
		});
		expect(deps.llm.generatePlans).not.toHaveBeenCalled();
		expect(deps.backend.audit).not.toHaveBeenCalled();
	});

	it("首轮通过:attempt=1", async () => {
		const deps = makeMockDeps();
		const plans = [makePlan("plan-A"), makePlan("plan-B"), makePlan("plan-C")];
		deps.backend.fetchContext.mockResolvedValue(makeContext());
		deps.llm.generatePlans.mockResolvedValue(plans);
		deps.backend.audit.mockResolvedValue(makeReport(true));
		const req = makeRequest();

		const result = await runGeneratePlan(req, deps);

		expect(result.plans).toEqual(plans);
		expect(result.attempt).toBe(1);
		expect(result.complianceReport?.passed).toBe(true);
		expect(deps.llm.generatePlans).toHaveBeenCalledTimes(1);
		expect(deps.backend.audit).toHaveBeenCalledTimes(1);
		// 首轮不应调 retry
		expect(deps.retry.buildRetryInstructions).not.toHaveBeenCalled();
	});

	it("首轮失败 + 重试通过:attempt=2,验证 retryInstructions 被传入", async () => {
		const deps = makeMockDeps();
		const failedPlans = [makePlan("plan-A")];
		const successPlans = [makePlan("plan-A-v2")];
		const failedReport = makeReport(false, { forbiddenWords: [{ word: "零风险", context: "方案plan-A", suggestion: "" }] });
		const retryInstructions = [{ planId: "plan-A", title: "方案plan-A", issues: [] }];

		deps.backend.fetchContext.mockResolvedValue(makeContext());
		deps.llm.generatePlans
			.mockResolvedValueOnce(failedPlans)
			.mockResolvedValueOnce(successPlans);
		deps.backend.audit
			.mockResolvedValueOnce(failedReport)
			.mockResolvedValueOnce(makeReport(true));
		deps.retry.buildRetryInstructions.mockReturnValue(retryInstructions);
		const req = makeRequest();

		const result = await runGeneratePlan(req, deps);

		expect(result.plans).toEqual(successPlans);
		expect(result.attempt).toBe(2);
		// 验证第 2 轮 generatePlans 收到 retryInstructions
		const secondCallArgs = deps.llm.generatePlans.mock.calls[1][0];
		expect(secondCallArgs.retryInstructions).toEqual(retryInstructions);
		// retry.buildRetryInstructions 收到上轮 plans + report
		expect(deps.retry.buildRetryInstructions).toHaveBeenCalledWith(failedPlans, failedReport);
	});

	it("3 轮耗尽:返回 error + 最后 report", async () => {
		const deps = makeMockDeps();
		const plans = [makePlan("plan-A")];
		const failedReport = makeReport(false);
		deps.backend.fetchContext.mockResolvedValue(makeContext());
		deps.llm.generatePlans.mockResolvedValue(plans);
		deps.backend.audit.mockResolvedValue(failedReport);
		deps.retry.buildRetryInstructions.mockReturnValue([]);
		const req = makeRequest();

		const result = await runGeneratePlan(req, deps);

		expect(result.plans).toEqual([]);
		expect(result.error).toBe("合规审查未通过，已重试3次");
		expect(result.complianceReport).toBe(failedReport);
		expect(deps.llm.generatePlans).toHaveBeenCalledTimes(3);
		expect(deps.backend.audit).toHaveBeenCalledTimes(3);
	});

	it("maxAttempts 自定义:2 轮耗尽", async () => {
		const deps = makeMockDeps();
		deps.maxAttempts = 2;
		deps.backend.fetchContext.mockResolvedValue(makeContext());
		deps.llm.generatePlans.mockResolvedValue([makePlan("plan-A")]);
		deps.backend.audit.mockResolvedValue(makeReport(false));
		const req = makeRequest();

		const result = await runGeneratePlan(req, deps);

		expect(result.error).toBe("合规审查未通过，已重试3次");
		expect(deps.llm.generatePlans).toHaveBeenCalledTimes(2);
	});

	it("提供 context 时直接使用,不再调用 fetchContext", async () => {
		const deps = makeMockDeps();
		const plans = [makePlan("plan-A"), makePlan("plan-B"), makePlan("plan-C")];
		deps.llm.generatePlans.mockResolvedValue(plans);
		deps.backend.audit.mockResolvedValue(makeReport(true));
		// fetchContext 不 mock,若被调用会抛出异常
		const req = makeRequest("generate_plans", { context: makeContext() });

		const result = await runGeneratePlan(req, deps);

		expect(result.plans).toEqual(plans);
		expect(deps.backend.fetchContext).not.toHaveBeenCalled();
		// 验证传入 LLM 的 context 与给定一致
		const callArgs = deps.llm.generatePlans.mock.calls[0][0];
		expect(callArgs.context.customer.customerId).toBe("CUST_001");
	});

	it("未提供 context 时完整拉取", async () => {
		const deps = makeMockDeps();
		const plans = [makePlan("plan-A")];
		deps.backend.fetchContext.mockResolvedValue(makeContext());
		deps.llm.generatePlans.mockResolvedValue(plans);
		deps.backend.audit.mockResolvedValue(makeReport(true));
		const req = makeRequest();

		const result = await runGeneratePlan(req, deps);

		expect(result.plans).toEqual(plans);
		expect(deps.backend.fetchContext).toHaveBeenCalledTimes(1);
		expect(deps.backend.fetchContext).toHaveBeenCalledWith("CUST_001", "manager-local");
	});
});

// ========== optimize_plan 测试 ==========

describe("runOptimizePlan", () => {
	it("缺 instruction 时返回参数错误,不调 backend/LLM", async () => {
		const deps = makeMockDeps();
		const req = makeRequest("optimize_plan", {
			target_plan_id: "plan-A",
			previous_plans: [makePlan("plan-A")],
		});

		const result = await runOptimizePlan(req, deps);

		expect(result).toEqual({ plans: [], error: "缺少优化指令(instruction)" });
		expect(deps.backend.fetchContext).not.toHaveBeenCalled();
		expect(deps.llm.generatePlans).not.toHaveBeenCalled();
	});

	it("缺 target_plan_id 时返回参数错误", async () => {
		const deps = makeMockDeps();
		const req = makeRequest("optimize_plan", {
			instruction: "增加稳健产品",
			previous_plans: [makePlan("plan-A")],
		});

		const result = await runOptimizePlan(req, deps);

		expect(result).toEqual({ plans: [], error: "缺少目标方案 ID(target_plan_id)" });
	});

	it("previous_plans 数量错误时返回参数错误", async () => {
		const deps = makeMockDeps();
		const req = makeRequest("optimize_plan", {
			instruction: "增加稳健产品",
			target_plan_id: "plan-A",
			previous_plans: [makePlan("plan-A"), makePlan("plan-B")],
		});

		const result = await runOptimizePlan(req, deps);

		expect(result.error).toContain("previous_plans 必须恰好包含一套与 target_plan_id 匹配的方案");
	});

	it("previous_plans[0].planId !== target_plan_id 时返回参数错误", async () => {
		const deps = makeMockDeps();
		const req = makeRequest("optimize_plan", {
			instruction: "增加稳健产品",
			target_plan_id: "plan-A",
			previous_plans: [makePlan("plan-B")],
		});

		const result = await runOptimizePlan(req, deps);

		expect(result.error).toContain("previous_plans 必须恰好包含一套与 target_plan_id 匹配的方案");
	});

	it("正常路径:生成 1 套优化方案", async () => {
		const deps = makeMockDeps();
		const previousPlan = makePlan("plan-A");
		const optimizedPlan = makePlan("plan-A", "优化后方案");
		deps.backend.fetchContext.mockResolvedValue(makeContext());
		deps.llm.generatePlans.mockResolvedValue([optimizedPlan]);
		deps.backend.audit.mockResolvedValue(makeReport(true));
		const req = makeRequest("optimize_plan", {
			instruction: "增加稳健产品",
			target_plan_id: "plan-A",
			previous_plans: [previousPlan],
		});

		const result = await runOptimizePlan(req, deps);

		expect(result.plans).toEqual([optimizedPlan]);
		expect(result.attempt).toBe(1);
		// 验证 generatePlans 收到 mode=optimize + previousPlan + instruction
		const callArgs = deps.llm.generatePlans.mock.calls[0][0];
		expect(callArgs.mode).toBe("optimize");
		expect(callArgs.previousPlan).toEqual(previousPlan);
		expect(callArgs.instruction).toBe("增加稳健产品");
	});

	it("风控闸门:riskTolerance 为空时拦截", async () => {
		const deps = makeMockDeps();
		deps.backend.fetchContext.mockResolvedValue(makeContext(""));
		const req = makeRequest("optimize_plan", {
			instruction: "增加稳健产品",
			target_plan_id: "plan-A",
			previous_plans: [makePlan("plan-A")],
		});

		const result = await runOptimizePlan(req, deps);

		expect(result.error).toBe("客户风险承受能力未评估，请先完成风险评估后再生成方案");
		expect(deps.llm.generatePlans).not.toHaveBeenCalled();
	});

	it("提供 context 时直接使用,不再调用 fetchContext", async () => {
		const deps = makeMockDeps();
		const previousPlan = makePlan("plan-A");
		const optimizedPlan = makePlan("plan-A", "优化后方案");
		deps.llm.generatePlans.mockResolvedValue([optimizedPlan]);
		deps.backend.audit.mockResolvedValue(makeReport(true));
		const req = makeRequest("optimize_plan", {
			instruction: "增加稳健产品",
			target_plan_id: "plan-A",
			previous_plans: [previousPlan],
			context: makeContext(),
		});

		const result = await runOptimizePlan(req, deps);

		expect(result.plans).toEqual([optimizedPlan]);
		expect(deps.backend.fetchContext).not.toHaveBeenCalled();
		const callArgs = deps.llm.generatePlans.mock.calls[0][0];
		expect(callArgs.context.customer.customerId).toBe("CUST_001");
	});
});
