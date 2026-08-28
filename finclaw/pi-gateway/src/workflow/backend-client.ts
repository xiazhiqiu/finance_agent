/**
 * backend HTTP 客户端
 *
 * 封装 backend 的取数与合规审查调用,等价于
 * .pi/skills/plan-generator/scripts/context.mjs 与
 * .pi/skills/compliance-auditor/scripts/audit.mjs 的逻辑,改为 TS 直连。
 *
 * HTTP 基建(配置读取/鉴权头/GET-POST-PUT 与 { data } 解包)复用 tools/backend-http.ts。
 */

import { backendGet, backendPost, backendPut } from "../tools/backend-http.ts";
import type {
	BackendClient,
	ComplianceReport,
	CustomerProfile,
	CustomerTask,
	FetchScope,
	MarketingPlan,
	Product,
	WorkflowContext,
} from "./types.ts";
import { getCaseStore } from "./case-store.ts";

/**
 * 创建 backend 客户端。配置从 process.env 读取,
 * 不传参即可在单测中替换为 mock(通过 WorkflowDeps 注入)。
 */
export function createBackendClient(): BackendClient {
	return {
		async fetchContext(
			customerId: string,
			managerId: string,
			scope: FetchScope = "plan",
		): Promise<WorkflowContext> {
			const encodedCustomerId = encodeURIComponent(customerId);
			// customer scope:只取客户画像(洞察/自进化场景,不消费产品与市场数据)
			if (scope === "customer") {
				const customer = await backendGet<CustomerProfile>(
					`/api/customers/${encodedCustomerId}/profile`,
					managerId,
				);
				return { customer, products: [], personalKnowledge: "", marketBrief: "" };
			}
			// plan scope:按 scope 并发取数(对齐 context.mjs:42-47)
			// 注意:/api/knowledge 不传 ?managerId= 查询参数,
			// backend server.mjs:330-333 忽略 query,managerId 来自 x-manager-id header
			// market brief 失败降级为空字符串,不阻塞方案生成
			const [customer, products, knowledge, market, tasks] = await Promise.all([
				backendGet<CustomerProfile>(
					`/api/customers/${encodedCustomerId}/profile`,
					managerId,
				),
				backendGet<Product[]>(
					`/api/products/eligible?customerId=${encodedCustomerId}`,
					managerId,
				),
				backendGet<{ content: string } & Record<string, unknown>>(
					"/api/knowledge",
					managerId,
				),
				backendGet<{ content: string } & Record<string, unknown>>(
					"/api/market/brief",
					managerId,
				).catch(() => ({ content: "" })),
				backendGet<CustomerTask[]>(
					`/api/customers/${encodedCustomerId}/tasks`,
					managerId,
				).catch(() => []),
			]);
			// knowledge 响应可能为字符串或 { ...parsedFields, content },
			// 取 content 作为 personalKnowledge(对齐 context.mjs:60)
			const personalKnowledge =
				typeof knowledge === "string"
					? knowledge
					: (knowledge?.content ?? "");
			// 知识沉淀:检索相似案例(embedding 失败时静默降级为空,不阻断主流程)
			const similarCases = await getCaseStore()
				.search(customer, managerId, 3)
				.then((r) => r.cases)
				.catch(() => []);
			return {
				customer,
				products,
				// 该客户命中的营销任务注入 strategies(取自 customer_tasks.json)
				strategies: tasks,
				personalKnowledge,
				marketBrief: market?.content ?? "",
				similarCases,
			};
		},

		async audit(
			customerId: string,
			plans: MarketingPlan[],
			managerId: string,
		): Promise<ComplianceReport> {
			const report = await backendPost<ComplianceReport>(
				"/api/plans/audit",
				managerId,
				{ customerId, plans },
			);
			if (!report || typeof report.passed !== "boolean") {
				throw new Error("/api/plans/audit returned an invalid ComplianceReport");
			}
			return report;
		},
	};
}

// ========== 洞察相关 backend 读写（原先在 insight-orchestrator 内） ==========

/**
 * 写洞察到 backend（POST /api/insights）。
 */
export async function backendWriteInsight(
	customerId: string,
	insight: { content: string; tags: string[]; source: "llm" },
	managerId: string,
): Promise<unknown> {
	return backendPost("/api/insights", managerId, {
		customerId,
		content: insight.content,
		tags: insight.tags,
		source: insight.source,
	});
}

/**
 * 读取客户洞察（GET /api/insights?customerId=...），用于知识提取去重参考。
 * 非 2xx 返回空数组（降级为不去重）。
 */
export async function backendReadInsights(
	customerId: string,
	managerId: string,
): Promise<Array<{ content: string; tags?: string[] }>> {
	try {
		const list = await backendGet<Array<Record<string, unknown>>>(
			`/api/insights?customerId=${encodeURIComponent(customerId)}`,
			managerId,
		);
		return (list || []).map((i) => ({
			content: String(i.content ?? ""),
			tags: Array.isArray(i.tags)
				? i.tags.filter((t): t is string => typeof t === "string")
				: undefined,
		}));
	} catch {
		return [];
	}
}

/**
 * 读取客户规则任务（GET /api/customers/:id/tasks）。非 2xx 返回空数组。
 */
export async function backendReadRuleTasks(
	customerId: string,
	managerId: string,
): Promise<Array<{ strategyType: string; strategyName: string; triggerCondition: string }>> {
	try {
		const tasks = await backendGet<Array<Record<string, unknown>>>(
			`/api/customers/${encodeURIComponent(customerId)}/tasks`,
			managerId,
		);
		return (tasks || []).map((t) => ({
			strategyType: String(t.strategyType ?? ""),
			strategyName: String(t.strategyName ?? ""),
			triggerCondition: String(t.triggerCondition ?? ""),
		}));
	} catch {
		return [];
	}
}

/** 客户级会话摘要写入 */
export async function backendPutSummary(
	customerId: string,
	summary: { preferences: string[]; adoptedPlans: string[]; concerns: string[]; opportunities: string[]; raw: string },
	managerId: string,
): Promise<unknown> {
	return backendPut(`/api/customers/${encodeURIComponent(customerId)}/summary`, managerId, summary);
}
