/**
 * Workflow 编排核心
 *
 * 纯函数式编排,所有外部依赖(backend HTTP / LLM 调用 / retry 构造)
 * 通过 WorkflowDeps 注入,使 orchestrator 在不配模型、不启 backend 的情况下
 * 可全分支单测。
 *
 * 顺序/并行/循环/分支全部用 TS 语言原语,不引入 YAML DSL 或状态机框架。
 */

import type {
	ComplianceReport,
	MarketingPlan,
	RetryInstruction,
	WorkflowContext,
	WorkflowDeps,
	WorkflowRequest,
	WorkflowResult,
} from "./types.ts";

const DEFAULT_MAX_ATTEMPTS = 3;

const RISK_GATE_ERROR = "客户风险承受能力未评估，请先完成风险评估后再生成方案";
const AUDIT_EXHAUSTED_ERROR = "合规审查未通过，已重试3次";

/**
 * 前置风控闸门:风险测评缺失 → 立即返回 error,不调 LLM、不调 audit。
 * customer 可能缺省(部分 context 场景),缺省视同未评估。
 */
function riskGateCheck(
	customer: { riskTolerance?: string } | undefined,
): { error: string } | null {
	if (!customer?.riskTolerance) {
		return { error: RISK_GATE_ERROR };
	}
	return null;
}

/**
 * 执行一轮 generate + audit 循环。
 * 返回 { done: true, result } 表示通过或耗尽;{ done: false, plans, report } 表示需重试。
 */
interface AttemptOutcome {
	done: true;
	result: WorkflowResult;
}

interface RetryOutcome {
	done: false;
	plans: MarketingPlan[];
	report: ComplianceReport;
}

async function attemptOnce(
	req: WorkflowRequest,
	deps: WorkflowDeps,
	context: Partial<WorkflowContext>,
	mode: "generate" | "optimize",
	extras: {
		previousPlan?: MarketingPlan;
		instruction?: string;
		retryInstructions?: RetryInstruction[];
	},
): Promise<AttemptOutcome | RetryOutcome> {
	const t0 = Date.now();
	const plans = await deps.llm.generatePlans({
		context,
		mode,
		retryInstructions: extras.retryInstructions,
		previousPlan: extras.previousPlan,
		instruction: extras.instruction,
	});
	const t1 = Date.now();
	const report = await deps.backend.audit(
		req.payload.customer_id,
		plans,
		req.payload.manager_id,
	);
	const t2 = Date.now();
	console.log(`[workflow] 阶段耗时 ${mode} generate=${t1 - t0}ms audit=${t2 - t1}ms 总=${t2 - t0}ms`);
	// 审查失败时打印完整失败原因，便于定位（如违禁词/风险揭示语缺失/产品错配）
	if (!report.passed) {
		console.error("[workflow] 合规审查未通过", JSON.stringify({
			customer_id: req.payload.customer_id,
			manager_id: req.payload.manager_id,
			mode,
			attempt_extras: {
				retry: extras.retryInstructions?.length ? `第 ${extras.retryInstructions.length} 组修正指令` : "首次",
			},
			report: {
				summary: report.summary,
				forbiddenWords: report.forbiddenWords,
				missingRiskDisclosures: report.missingRiskDisclosures,
				mismatchedProducts: report.mismatchedProducts,
				offSaleProducts: report.offSaleProducts,
			},
		}));
	}
	if (report.passed) {
		return {
			done: true,
			result: { plans, complianceReport: report },
		};
	}
	return { done: false, plans, report };
}

/**
 * 执行一轮 attemptOnce 并统一记录未捕获异常后重新抛出。
 * 系统级异常只落服务端日志,由上层(plan-tools)统一转成用户友好提示,不下发内部细节。
 */
async function runAttempt(
	label: string,
	ctx: Record<string, unknown>,
	fn: () => Promise<AttemptOutcome | RetryOutcome>,
): Promise<AttemptOutcome | RetryOutcome> {
	try {
		return await fn();
	} catch (error) {
		console.error(label, {
			...ctx,
			error: error instanceof Error ? error.message : String(error),
		});
		throw error;
	}
}

/**
 * generate_plans 编排:取数 → 风控闸门 → 循环最多 maxAttempts 轮
 * (每轮 generatePlans + audit)→ 通过返回 / 失败重试 / 耗尽返回 error。
 */
export async function runGeneratePlan(
	req: WorkflowRequest,
	deps: WorkflowDeps,
): Promise<WorkflowResult> {
	const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

	// 1. 取数 — 如果提供了 context 则直接使用，否则从 backend 拉取
	const tFetch0 = Date.now();
	const context = req.payload.context ?? await deps.backend.fetchContext(
		req.payload.customer_id,
		req.payload.manager_id,
	);
	console.log(`[workflow] 阶段耗时 fetchContext=${Date.now() - tFetch0}ms`);

	// 2. 前置风控闸门(确定性,代码判断)
	const riskError = riskGateCheck(context.customer);
	if (riskError) {
		return { plans: [], error: riskError.error };
	}

	// 3. 循环最多 maxAttempts 轮
	let lastReport: ComplianceReport | undefined;
	let lastPlans: MarketingPlan[] | undefined;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const retryInstructions =
			attempt > 1 && lastReport && lastPlans
				? deps.retry.buildRetryInstructions(lastPlans, lastReport)
				: undefined;

		const outcome = await runAttempt(
			"[workflow] generate_plans 执行异常",
			{
				customer_id: req.payload.customer_id,
				manager_id: req.payload.manager_id,
				attempt,
			},
			() => attemptOnce(req, deps, context, "generate", { retryInstructions }),
		);

		if (outcome.done) {
			return { ...outcome.result, attempt };
		}
		lastReport = outcome.report;
		lastPlans = outcome.plans;
	}

	// 4. 3 轮耗尽
	return {
		plans: [],
		error: AUDIT_EXHAUSTED_ERROR,
		complianceReport: lastReport,
	};
}

/**
 * optimize_plan 编排:参数校验 → 取数 → 风控闸门 → 循环
 * (mode: "optimize", previousPlan + instruction 注入,生成 1 套)。
 */
export async function runOptimizePlan(
	req: WorkflowRequest,
	deps: WorkflowDeps,
): Promise<WorkflowResult> {
	const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
	const payload = req.payload;

	// 1. 参数校验(确定性,代码判断)
	if (!payload.instruction) {
		return { plans: [], error: "缺少优化指令(instruction)" };
	}
	if (!payload.target_plan_id) {
		return { plans: [], error: "缺少目标方案 ID(target_plan_id)" };
	}
	const previousPlans = payload.previous_plans;
	if (
		!Array.isArray(previousPlans) ||
		previousPlans.length !== 1 ||
		previousPlans[0].planId !== payload.target_plan_id
	) {
		return {
			plans: [],
			error: "previous_plans 必须恰好包含一套与 target_plan_id 匹配的方案",
		};
	}
	const previousPlan = previousPlans[0];

	// 2. 取数 — 如果提供了 context 则直接使用（注意：第2步，参数校验在第1步）
	const context = req.payload.context ?? await deps.backend.fetchContext(
		payload.customer_id,
		payload.manager_id,
	);

	// 3. 前置风控闸门
	const riskError = riskGateCheck(context.customer);
	if (riskError) {
		return { plans: [], error: riskError.error };
	}

	// 4. 循环
	let lastReport: ComplianceReport | undefined;
	let lastPlans: MarketingPlan[] | undefined;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const retryInstructions =
			attempt > 1 && lastReport && lastPlans
				? deps.retry.buildRetryInstructions(lastPlans, lastReport)
				: undefined;

		const outcome = await runAttempt(
			"[workflow] optimize_plan 执行异常",
			{
				customer_id: payload.customer_id,
				manager_id: payload.manager_id,
				target_plan_id: payload.target_plan_id,
				attempt,
			},
			() =>
				attemptOnce(req, deps, context, "optimize", {
					previousPlan,
					instruction: payload.instruction,
					retryInstructions,
				}),
		);

		if (outcome.done) {
			return { ...outcome.result, attempt };
		}
		lastReport = outcome.report;
		lastPlans = outcome.plans;
	}

	// 5. 3 轮耗尽
	return {
		plans: [],
		error: AUDIT_EXHAUSTED_ERROR,
		complianceReport: lastReport,
	};
}
