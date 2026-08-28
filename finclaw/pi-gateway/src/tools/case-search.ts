/**
 * 自定义工具：case_search（案例检索）
 *
 * 基于客户画像从案例库检索相似成交案例，供主对话 Agent 在聊天时
 * 为客户经理提供历史参考案例。
 *
 * 工具名：case_search
 * 参数：customerId（必填），limit（可选，默认 3）
 */

import { Type, type Static, type TSchema } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { backendPost } from "./backend-http.ts";

interface CaseSearchRequestBody {
	customerId: string;
	limit?: number;
}

interface CaseSearchHttpResponse {
	cases?: Array<{
		caseId: string;
		title: string;
		diagnosis: string;
		score: number;
		tags: string[];
		allocation: Record<string, { pct: number; products: string[] }>;
		products: Array<{ name: string; category: string; riskLevel: string; reason: string }>;
	}>;
	totalFound?: number;
	strategy?: string;
}

const caseSearchParams = Type.Object({
	customerId: Type.String({ description: "客户 ID，必须从会话业务上下文中的 customer.customerId 获取，不得自行编造" }),
	limit: Type.Optional(
		Type.Number({ description: "返回案例数量上限，默认 3" }),
	),
});

type CaseSearchParams = Static<typeof caseSearchParams>;

export function createCaseSearchTool(): ToolDefinition<TSchema, unknown> {
	return {
		name: "case_search",
		label: "案例检索",
		description:
			"基于客户画像从案例库中检索相似成交案例，返回匹配的案例摘要（含评分、标签、诊断、配置比例）。用于回答客户经理关于历史成交案例、相似客户参考的问题。",
		promptSnippet:
			"case_search(customerId, limit?) - 检索相似成交案例供参考",
		parameters: caseSearchParams as TSchema,
		async execute(
			_toolCallId: string,
			params: CaseSearchParams,
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: unknown,
		) {
			const ctxObj = ctx as { managerId?: string };
			const managerId =
				ctxObj?.managerId || process.env.FINANCE_DEFAULT_MANAGER || "MGR_001";

			try {
				const body: CaseSearchRequestBody = {
					customerId: params.customerId,
					limit: params.limit ?? 3,
				};
				const result = await backendPost<CaseSearchHttpResponse>(
					"/api/case-store/search",
					managerId,
					body,
				);
				const list = Array.isArray(result?.cases) ? result.cases : [];
				if (list.length === 0) {
					return {
						content: [
							{
								type: "text" as const,
								text: `未找到与客户 ${params.customerId} 画像相似的成交案例。`,
							},
						],
						details: { success: true, cases: [], totalFound: 0, strategy: result?.strategy ?? "none" },
					};
				}
				const lines = [`找到 ${list.length} 个相似成交案例：`, ""];
				for (const c of list) {
					const tags = Array.isArray(c.tags) && c.tags.length > 0 ? ` [${c.tags.join("/")}]` : "";
					lines.push(`**${c.title}**（${c.score} 分）${tags}`);
					if (c.diagnosis) lines.push(`  ${c.diagnosis.slice(0, 80)}`);
					lines.push("");
				}
				lines.push("如需查看完整案例详情（配置比例、产品列表），请告知具体案例。");
				return {
					content: [{ type: "text" as const, text: lines.join("\n") }],
					details: { success: true, cases: list, totalFound: result?.totalFound ?? list.length, strategy: result?.strategy ?? "full" },
				};
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text" as const, text: `案例检索失败：${msg}` }],
					details: { success: false, error: msg },
				};
			}
		},
	};
}