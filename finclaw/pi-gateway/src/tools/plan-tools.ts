/**
 * 自定义工具：方案生成 + 方案优化
 *
 * 将 workflow 引擎（runGeneratePlan / runOptimizePlan）包装为 Pi SDK 自定义工具，
 * 让主对话 Agent 在自由聊天时通过工具调用完成方案生成/优化。
 *
 * - generate_plan(customer_id, manager_id?, context?): 完整拉取上下文并生成方案
 * - optimize_plan(customer_id, manager_id?, target_plan_id, instruction, context?):
 *   基于目标方案 + 指令优化；context 提供时直接使用，否则从 backend 拉取
 *
 * context 为可选字段（customer_profile/eligible_products/personal_knowledge/market_brief/previous_plans），
 * 传入时 workflow 直接用，不传则完整跑 workflow。
 */

import { randomUUID } from "node:crypto";
import { Type, type Static, type TSchema } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	createWorkflowDeps,
	runGeneratePlan,
	runOptimizePlan,
	type WorkflowContext,
	type WorkflowDeps,
	type WorkflowRequest,
	type WorkflowResult,
} from "../workflow/index.ts";
import { findPlanFromBackend } from "./backend-http.ts";

// ========== 工具参数 ==========

const planToolParams = Type.Object({
	customer_id: Type.String({ description: "客户 ID，必须从会话业务上下文中的 customer.customerId 获取，不得自行编造" }),
	manager_id: Type.Optional(
		Type.String({ description: "客户经理 ID，缺省取当前会话经理" }),
	),
	/** 优化目标方案 ID（优化时必填） */
	target_plan_id: Type.Optional(
		Type.String({ description: "优化目标方案 ID，优化时必填" }),
	),
	/** 优化指令（优化时必填） */
	instruction: Type.Optional(
		Type.String({ description: "优化指令，如：将权益比例降低到 20%" }),
	),
	/** 可选上下文：提供时 workflow 直接使用，不再重新拉取数据 */
	context: Type.Optional(
		Type.Object(
			{
				customer_profile: Type.Optional(Type.Any()),
				eligible_products: Type.Optional(Type.Array(Type.Any())),
				personal_knowledge: Type.Optional(Type.String()),
				market_brief: Type.Optional(Type.String()),
				previous_plans: Type.Optional(Type.Array(Type.Any())),
			},
			{
				description:
					"可选业务上下文（customer_profile/eligible_products/personal_knowledge/market_brief/previous_plans），传入时 workflow 直接用，不传则完整拉取",
			},
		),
	),
});

type PlanToolParams = Static<typeof planToolParams>;

interface ToolExecutionContext {
	managerId?: string;
}

// ========== 工具逻辑（纯函数，便于单测注入 mock deps） ==========

/**
 * 执行方案生成/优化工具。
 * @param deps 注入 workflow 依赖（默认生产装配），单测可传 mock。
 */
export async function executePlanTool(
	params: PlanToolParams,
	ctx: ToolExecutionContext = {},
	deps: WorkflowDeps = createWorkflowDeps(),
): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }> {
	const managerId =
		params.manager_id || ctx.managerId || process.env.FINANCE_DEFAULT_MANAGER || "MGR_001";
	const isOptimize = Boolean(params.target_plan_id && params.instruction);

	try {
		let result: WorkflowResult;

		if (isOptimize) {
			// 优化：准备 previous_plans（context 提供则直接用，否则查 backend）
			const provided = params.context?.previous_plans;
			const previousPlans = Array.isArray(provided) && provided.length === 1
				? provided
				: await (async () => {
						const plan = await findPlanFromBackend(
							params.customer_id,
							managerId,
							params.target_plan_id!,
						);
						return plan ? [plan] : [];
					})();

			if (previousPlans.length !== 1) {
				return {
					content: [{
						type: "text",
						text: `未找到目标方案（target_plan_id=${params.target_plan_id}），请先生成方案后再优化。`,
					}],
					details: { success: false, kind: "optimize_plan", error: "目标方案不存在" },
				};
			}

			const req: WorkflowRequest = {
				action: "optimize_plan",
				payload: {
					customer_id: params.customer_id,
					manager_id: managerId,
					instruction: params.instruction!,
					target_plan_id: params.target_plan_id!,
					previous_plans: previousPlans as WorkflowRequest["payload"]["previous_plans"],
					context: params.context ? normalizeContext(params.context) : undefined,
				},
			};
			result = await runOptimizePlan(req, deps);
		} else {
			const req: WorkflowRequest = {
				action: "generate_plans",
				payload: {
					customer_id: params.customer_id,
					manager_id: managerId,
					context: params.context ? normalizeContext(params.context) : undefined,
				},
			};
			result = await runGeneratePlan(req, deps);
		}

		if (result.error) {
			return {
				content: [{ type: "text", text: `方案${isOptimize ? "优化" : "生成"}失败：${result.error}` }],
				details: { success: false, kind: isOptimize ? "optimize_plan" : "generate_plan", error: result.error },
			};
		}

		// 优化方案必须分配唯一 planId：LLM 倾向于复用目标方案 planId，
		// 若不改写会导致 1) 快照按 planId 幂等去重时新方案被丢弃；2) 前端/模型
		// 引用的 planId 与快照不一致，get_plan(plan_id) 查回目标方案而非优化结果。
		if (isOptimize && result.plans.length > 0 && result.plans[0]) {
			result.plans[0].planId = `${params.target_plan_id}-opt-${randomUUID().slice(0, 8)}`;
		}

		// 工具 content 只保留轻量摘要列表（不注入完整 JSON），完整方案走 details.result 供前端渲染
		const header = isOptimize
			? "已基于目标方案完成优化，共 1 套方案（含合规审查结果）。"
			: `已为客户生成 ${result.plans.length} 套方案（含合规审查结果）。`;
		const lines = result.plans.map((plan, i) => {
			const title = plan.title || "未命名方案";
			const score = plan.score ?? "-";
			const summary = summarizeDiagnosis(plan.diagnosis, plan.tags);
			return `- ${isOptimize ? "优化版" : `方案 ${String.fromCharCode(65 + i)}`} [${plan.planId}] ${title} · ${score} 分 · ${summary}`;
		});
		const compliance = result.complianceReport?.passed ? "全部通过" : "存在风险提示";
		const summary = `${header}\n\n${lines.join("\n")}\n\n合规审查：${compliance}\n如需方案详细数据（配置比例/产品列表/话术/合规报告），可调用 get_plan(plan_id) 获取。`;
		return {
			content: [{ type: "text", text: summary }],
			details: {
				success: true,
				kind: isOptimize ? "optimize_plan" : "generate_plan",
				result,
			},
		};
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		// 系统级异常只落服务端日志与 details（供排查），不下发到用户可见的助手回复，
		// 避免原始内部错误（如 LLM JSON 解析细节/原始输出摘录）泄露到回答中。
		console.error(`[plan-tools] 方案${isOptimize ? "优化" : "生成"}异常`, {
			customer_id: params.customer_id,
			manager_id: managerId,
			target_plan_id: params.target_plan_id,
			error: msg,
		});
		return {
			content: [{ type: "text", text: `方案${isOptimize ? "优化" : "生成"}未能完成，请稍后重试。` }],
			details: { success: false, kind: isOptimize ? "optimize_plan" : "generate_plan", error: msg },
		};
	}
}

/** 将工具的可选 context 规整为 WorkflowContext（空则返回 undefined，由 workflow 自行拉取） */
function normalizeContext(
	ctx: NonNullable<PlanToolParams["context"]>,
): Partial<WorkflowContext> | undefined {
	const out: Partial<WorkflowContext> = {};
	if (ctx.customer_profile) out.customer = ctx.customer_profile as WorkflowContext["customer"];
	if (Array.isArray(ctx.eligible_products) && ctx.eligible_products.length > 0) {
		out.products = ctx.eligible_products as WorkflowContext["products"];
	}
	if (typeof ctx.personal_knowledge === "string" && ctx.personal_knowledge.trim()) {
		out.personalKnowledge = ctx.personal_knowledge;
	}
	if (typeof ctx.market_brief === "string" && ctx.market_brief.trim()) {
		out.marketBrief = ctx.market_brief;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

/** 从诊断文本/tags 提炼一句话摘要（截断超长文本，避免上下文膨胀） */
function summarizeDiagnosis(diagnosis: string | undefined, tags: string[] | undefined): string {
	const tagText = Array.isArray(tags) && tags.length > 0 ? tags.join("/") : "";
	const source = diagnosis?.trim() || tagText || "暂无描述";
	return source.length > 40 ? `${source.slice(0, 40)}…` : source;
}

// ========== 工具定义 ==========

function createGeneratePlanTool(): ToolDefinition<typeof planToolParams, unknown> {
	return {
		name: "generate_plan",
		label: "生成方案",
		description:
			"为指定客户生成营销方案（3 套 + 合规审查）。可传入可选 context 以复用已有数据，不传则自动拉取客户画像/适配产品/知识库。",
		promptSnippet:
			"generate_plan(customer_id, manager_id?, context?) - 为客户生成营销方案并合规审查",
		parameters: planToolParams,
		async execute(
			_toolCallId: string,
			params: PlanToolParams,
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: unknown,
		) {
			return executePlanTool(params, ctx as ToolExecutionContext);
		},
	};
}

function createOptimizePlanTool(): ToolDefinition<typeof planToolParams, unknown> {
	return {
		name: "optimize_plan",
		label: "优化方案",
		description:
			"基于指定目标方案（target_plan_id）和优化指令（instruction）优化生成 1 套新方案。目标方案从上下文或后端会话自动定位，也可通过 context.previous_plans 直接提供。",
		promptSnippet:
			"optimize_plan(customer_id, target_plan_id, instruction, manager_id?, context?) - 优化指定方案",
		parameters: planToolParams,
		async execute(
			_toolCallId: string,
			params: PlanToolParams,
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: unknown,
		) {
			return executePlanTool(params, ctx as ToolExecutionContext);
		},
	};
}

export function createPlanTools(): ToolDefinition<typeof planToolParams, unknown>[] {
	return [createGeneratePlanTool(), createOptimizePlanTool()];
}
