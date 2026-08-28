/**
 * 自定义工具：客户分析 + 产品查询
 *
 * 让主对话 Agent 在自由聊天时能通过工具调用获取实时业务数据，
 * 而非依赖 bash + curl 间接访问 backend。
 *
 * 工具列表：
 * - customer_analyze: 获取客户画像、任务、洞察，返回结构化分析文本
 * - product_query: 查询客户适配产品列表
 */

import { Type, type Static, type TSchema } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { MarketingPlan, CustomerProfile, Product } from "../workflow/types.ts";
import { createPlanTools } from "./plan-tools.ts";
import { createSaveKnowledgeTool } from "./save-knowledge.ts";
import { createCaseSearchTool } from "./case-search.ts";
import { backendGet } from "./backend-http.ts";

// ========== 业务数据类型（对齐 backend） ==========

interface Insight {
	insightId: string;
	customerId: string;
	content: string;
	tags: string[];
	status: string;
	source: string;
	createdAt: string;
}

// ========== 工具 1: customer_analyze ==========

const customerAnalyzeParams = Type.Object({
	customerId: Type.String({ description: "客户 ID，必须从会话业务上下文中的 customer.customerId 获取，不得自行编造" }),
	analyzeType: Type.Optional(
		Type.String({
			description: "分析维度：asset（资产结构）/ risk（风险评估）/ marketing（营销机会）/ full（全量，默认）",
		}),
	),
});

type CustomerAnalyzeParams = Static<typeof customerAnalyzeParams>;

/**
 * 将客户画像格式化为 LLM 可读的分析文本。
 */
function formatCustomerAnalysis(
	customer: CustomerProfile,
	tasks: CustomerProfile["tasks"],
	insights: Insight[],
	analyzeType: string,
): string {
	const lines: string[] = [];

	if (analyzeType === "asset" || analyzeType === "full") {
		lines.push("## 资产结构分析");
		lines.push(`- 客户：${customer.name}（${customer.customerId}）`);
		lines.push(`- 客户分群：${customer.segment || "未分类"}`);
		lines.push(`- AUM：${(customer.aum / 10000).toFixed(1)} 万元`);
		if (customer.aumStructure) {
			lines.push("- 资产配置：");
			for (const [category, pct] of Object.entries(customer.aumStructure)) {
				lines.push(`  - ${category}：${pct}%`);
			}
		}
		if (customer.upcomingMaturities?.length) {
			lines.push("- 即将到期产品：");
			for (const m of customer.upcomingMaturities) {
				lines.push(`  - ${m.productType}：${(m.amount / 10000).toFixed(1)} 万元，到期日 ${m.dueDate}`);
			}
		}
		lines.push("");
	}

	if (analyzeType === "risk" || analyzeType === "full") {
		lines.push("## 风险评估");
		lines.push(`- 风险承受能力：${customer.riskTolerance || "未评估"}`);
		lines.push(`- 风险评估日期：${customer.riskAssessmentDate || "无记录"}`);
		lines.push(`- 生命周期阶段：${customer.lifeCycleStage || "未知"}`);
		lines.push("");
	}

	if (analyzeType === "marketing" || analyzeType === "full") {
		lines.push("## 营销机会");
		if (customer.lastContact) {
			lines.push(`- 最近触客：${customer.lastContact.date} via ${customer.lastContact.channel}，话题：${customer.lastContact.topic}`);
		}
		if (customer.preferences?.length) {
			lines.push(`- 偏好：${customer.preferences.join("、")}`);
		}
		if (tasks?.length) {
			lines.push("- 待办任务：");
			for (const t of tasks) {
				if (t.status === "pending") {
					lines.push(`  - [${t.strategyName}] 优先级 ${t.priority}（${t.strategyType}）`);
				}
			}
		}
		if (insights?.length) {
			lines.push("- 已有洞察：");
			for (const i of insights.slice(0, 5)) {
				lines.push(`  - [${i.status}] ${i.content}`);
			}
		}
		if (customer.tags?.length) {
			lines.push(`- 标签：${customer.tags.join("、")}`);
		}
		lines.push("");
	}

	return lines.join("\n");
}

export function createCustomerAnalyzeTool(): ToolDefinition<TSchema, unknown> {
	return {
		name: "customer_analyze",
		label: "客户分析",
		description:
			"获取指定客户的画像、待办任务和洞察，返回结构化分析文本。用于回答客户经理关于客户资产、风险、营销机会的咨询。",
		promptSnippet: "customer_analyze(customerId, analyzeType?) - 获取客户画像/任务/洞察分析",
		parameters: customerAnalyzeParams as TSchema,
		async execute(
			_toolCallId: string,
			params: CustomerAnalyzeParams,
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: unknown,
		) {
			// 从 ctx 中提取 managerId（ExtensionContext 提供）
			const ctxObj = ctx as { managerId?: string };
			const managerId = ctxObj?.managerId || process.env.FINANCE_DEFAULT_MANAGER || "MGR_001";
			const analyzeType = params.analyzeType || "full";

			try {
				const encodedId = encodeURIComponent(params.customerId);
				const [customer, insights] = await Promise.all([
					backendGet<CustomerProfile>(
						`/api/customers/${encodedId}/profile`,
						managerId,
					),
					backendGet<Insight[]>(
						`/api/insights?customerId=${encodedId}`,
						managerId,
					).catch(() => [] as Insight[]),
				]);

				const analysis = formatCustomerAnalysis(
					customer,
					customer.tasks,
					insights,
					analyzeType,
				);

				return {
					content: [{ type: "text" as const, text: analysis }],
					details: { customerId: params.customerId, analyzeType, success: true },
				};
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text" as const, text: `客户分析失败：${msg}` }],
					details: { customerId: params.customerId, success: false, error: msg },
				};
			}
		},
	};
}

// ========== 工具 2: product_query ==========

const productQueryParams = Type.Object({
	customerId: Type.Optional(
		Type.String({ description: "客户 ID，传入则返回该客户适配的在售产品列表" }),
	),
	category: Type.Optional(
		Type.String({ description: "产品类别筛选，如 固收理财/现金管理/基金/保险" }),
	),
});

type ProductQueryParams = Static<typeof productQueryParams>;

export function createProductQueryTool(): ToolDefinition<TSchema, unknown> {
	return {
		name: "product_query",
		label: "产品查询",
		description:
			"查询在售产品列表，可按客户适配或按类别筛选。用于回答客户经理关于产品推荐和市场分析的咨询。",
		promptSnippet: "product_query(customerId?, category?) - 查询适配/在售产品列表",
		parameters: productQueryParams as TSchema,
		async execute(
			_toolCallId: string,
			params: ProductQueryParams,
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: unknown,
		) {
			const ctxObj = ctx as { managerId?: string };
			const managerId = ctxObj?.managerId || process.env.FINANCE_DEFAULT_MANAGER || "MGR_001";

			try {
				let products: Product[];
				if (params.customerId) {
					const encodedId = encodeURIComponent(params.customerId);
					products = await backendGet<Product[]>(
						`/api/products/eligible?customerId=${encodedId}`,
						managerId,
					);
				} else {
					products = await backendGet<Product[]>(
						"/api/products",
						managerId,
					);
				}

				if (params.category) {
					products = products.filter((p) => p.category === params.category);
				}

				const lines: string[] = [`## 产品列表（共 ${products.length} 款）`];
				for (const p of products.slice(0, 20)) {
					lines.push(
						`- **${p.name}**（${p.productId}）| ${p.category} | ${p.riskLevel} | 期限 ${p.tenor} | 预期收益 ${p.expectedReturn} | 起购 ${p.minAmount} 元${p.campaigns?.length ? ` | 活动：${p.campaigns.join("、")}` : ""}`,
					);
				}
				if (products.length > 20) {
					lines.push(`...还有 ${products.length - 20} 款产品未显示`);
				}

				return {
					content: [{ type: "text" as const, text: lines.join("\n") }],
					details: { count: products.length, success: true },
				};
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text" as const, text: `产品查询失败：${msg}` }],
					details: { success: false, error: msg },
				};
			}
		},
	};
}

// ========== 工具 3: market_query ==========

export function createMarketQueryTool(): ToolDefinition<TSchema, unknown> {
	return {
		name: "market_query",
		label: "市场简报",
		description:
			"获取当前市场简报（市场环境、利率与配置建议概述）。回答市场环境、利率影响、大类配置等问题时调用。",
		promptSnippet: "market_query() - 获取当前市场简报",
		parameters: Type.Object({}) as TSchema,
		async execute(
			_toolCallId: string,
			_params: Record<string, never>,
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: unknown,
		) {
			const ctxObj = ctx as { managerId?: string };
			const managerId = ctxObj?.managerId || process.env.FINANCE_DEFAULT_MANAGER || "MGR_001";

			try {
				const brief = await backendGet<{ content?: string }>("/api/market/brief", managerId);
				const content = typeof brief?.content === "string" ? brief.content : "";
				return {
					content: [{ type: "text" as const, text: content || "暂无市场简报" }],
					details: { success: true, empty: !content },
				};
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text" as const, text: `获取市场简报失败：${msg}` }],
					details: { success: false, error: msg },
				};
			}
		},
	};
}

// ========== 工具 4: get_plan（按需取用完整方案） ==========

const getPlanParams = Type.Object({
	plan_id: Type.String({ description: "方案 ID，如 plan-CUST_001-A" }),
});

type GetPlanParams = Static<typeof getPlanParams>;

interface SnapshotRecord extends Partial<MarketingPlan> {
	planId: string;
	customerId: string;
}

/** 将快照记录格式化为模型可读的完整方案详情 */
function formatPlanDetail(record: SnapshotRecord): string {
	const allocation = record.allocation ?? {};
	const products = record.products ?? [];
	const scripts: { wecom?: string; phone?: string[] } = record.scripts ?? {};
	const lines: string[] = [
		`## 方案详情：${record.title ?? "未命名方案"}`,
		`- 方案 ID：${record.planId ?? "-"}`,
		`- 评分：${record.score ?? "-"} 分`,
		`- 标签：${Array.isArray(record.tags) && record.tags.length ? record.tags.join("、") : "无"}`,
	];
	if (record.diagnosis) {
		lines.push("", "### 客户诊断", String(record.diagnosis));
	}
	if (Object.keys(allocation).length) {
		lines.push("", "### 配置比例");
		for (const [name, a] of Object.entries(allocation)) {
			lines.push(`- ${name}：${a.pct}% → ${(a.products ?? []).join("、")}`);
		}
	}
	if (products.length) {
		lines.push("", "### 推荐产品");
		for (const p of products) {
			lines.push(`- **${p.name}**（${p.productId}）| ${p.category} | 风险 ${p.riskLevel}${p.reason ? ` | ${p.reason}` : ""}`);
		}
	}
	if (scripts.wecom) {
		lines.push("", "### 企业微信话术", scripts.wecom);
	}
	if (Array.isArray(scripts.phone) && scripts.phone.length) {
		lines.push("", "### 电话话术");
		for (const s of scripts.phone) {
			lines.push(`- ${s}`);
		}
	}
	lines.push("", "理财有风险，投资需谨慎");
	return lines.join("\n");
}

export function createGetPlanTool(): ToolDefinition<TSchema, unknown> {
	return {
		name: "get_plan",
		label: "获取方案详情",
		description:
			"获取指定方案的完整详情（含资产配置、产品列表、话术脚本）。当需要引用方案的具体数据（如产品名称、配置比例、触客话术）时调用。",
		promptSnippet: "get_plan(plan_id) - 获取方案完整详情",
		parameters: getPlanParams as TSchema,
		async execute(
			_toolCallId: string,
			params: GetPlanParams,
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: unknown,
		) {
			const ctxObj = ctx as { managerId?: string };
			const managerId = ctxObj?.managerId || process.env.FINANCE_DEFAULT_MANAGER || "MGR_001";
			try {
				const encoded = encodeURIComponent(params.plan_id);
				const snapshots = await backendGet<unknown[]>(`/api/plans/${encoded}/snapshots`, managerId);
				const record = Array.isArray(snapshots) ? snapshots[0] : undefined;
				if (!record) {
					return {
						content: [{
							type: "text" as const,
							text: `未找到方案（plan_id=${params.plan_id}），请先通过 generate_plan 生成方案后再查询。`,
						}],
						details: { success: false, error: "方案不存在" },
					};
				}
				return {
					content: [{ type: "text" as const, text: formatPlanDetail(record as SnapshotRecord) }],
					details: { success: true, plan: record },
				};
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text" as const, text: `获取方案详情失败：${msg}` }],
					details: { success: false, error: msg },
				};
			}
		},
	};
}

/**
 * 导出全部自定义工具，供 agent-session.ts 注册。
 * 包含：customer_analyze / product_query / market_query / get_plan /
 *      generate_plan / optimize_plan / save_knowledge
 */
export function createCustomTools(): ToolDefinition<TSchema, unknown>[] {
	return [
		createCustomerAnalyzeTool(),
		createProductQueryTool(),
		createMarketQueryTool(),
		createGetPlanTool(),
		...createPlanTools(),
		createSaveKnowledgeTool(),
		createCaseSearchTool(),
	];
}
