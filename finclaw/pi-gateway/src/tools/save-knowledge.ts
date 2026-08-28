/**
 * 自定义工具：save_knowledge（显式指令触发知识沉淀）
 *
 * 当客户经理在主对话中说「记住」「记下来」「记一下」时，Agent 调用本工具，
 * 复用 extractors 提取模块完成「提取 + 去重」（输入含现有知识库/洞察全文），
 * 并按类别写入个人知识库对应段或客户洞察（customerInsight）。
 *
 * 置信度策略：
 * - 显式指令 → 直接写入，无需经理确认
 * - 写入位置：category=customerInsight → POST /api/insights（需 customer_id）
 *             其余类别 → 合并到 /api/knowledge 对应段
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Type, type Static, type TSchema } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { CustomerProfile } from "../workflow/types.ts";
import {
	extractKnowledge,
	guessCategory,
	type KnowledgeCategory,
} from "../workflow/extractors.ts";
import {
	backendReadInsights,
	backendWriteInsight,
} from "../workflow/backend-client.ts";
import { backendGet, backendPost } from "./backend-http.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** 与 workflow/index.ts 一致的 .pi 目录解析 */
function resolvePiAgentDir(): string {
	const envDir = process.env.PI_CODING_AGENT_DIR;
	if (envDir) return envDir;
	// tools/ → src/ → pi-gateway/ → finclaw/
	const finclawDir = join(__dirname, "..", "..", "..");
	return join(finclawDir, ".pi");
}

/** 无客户上下文时的占位画像（extractors 对缺省字段容忍） */
const EMPTY_CUSTOMER: CustomerProfile = {
	customerId: "",
	name: "",
	riskTolerance: "",
	aum: 0,
};

/** 知识类别 → 知识库段字段名（后端 knowledge.mjs 的 5 段结构） */
const CATEGORY_TO_FIELD: Partial<Record<KnowledgeCategory, string>> = {
	talkTemplates: "talkTemplates",
	productPriority: "productPriority",
	stylePreference: "stylePreference",
	combinationStrategy: "productPriority", // 组合策略并入产品优先度
	compliance: "compliance",
	objectionHandling: "talkTemplates", // 异议话术并入话术模板
	followUp: "followUp",
};

/** 读取当前知识库字段（不含 content 原稿），用于追加合并 */
async function readKnowledgeFields(
	managerId: string,
): Promise<Record<string, string>> {
	const current = await backendGet<Record<string, unknown>>(
		"/api/knowledge",
		managerId,
	);
	const fields: Record<string, string> = {};
	for (const [key, value] of Object.entries(current ?? {})) {
		if (key === "content" || typeof value !== "string") continue;
		fields[key] = value;
	}
	return fields;
}

/** 将提取内容合并追加到知识库对应段（读-改-写） */
async function mergeIntoKnowledge(
	managerId: string,
	field: string,
	content: string,
): Promise<void> {
	const fields = await readKnowledgeFields(managerId);
	const existing = fields[field]?.trim();
	fields[field] = existing ? `${existing}\n${content}` : content;
	await backendPost("/api/knowledge/save", managerId, fields);
}

const saveKnowledgeParams = Type.Object({
	content: Type.String({
		description: "经理要记住的知识内容，如「企业主客户更看重流动性」",
	}),
	category: Type.Optional(
		Type.String({
			description:
				"知识类别：talkTemplates/productPriority/stylePreference/combinationStrategy/compliance/objectionHandling/followUp/customerInsight",
		}),
	),
	customer_id: Type.Optional(
		Type.String({
			description:
				"客户 ID（可选）：传入时按该客户画像上下文提取，customerInsight 类写入该客户洞察；不传时只写入个人知识库",
		}),
	),
});

type SaveKnowledgeParams = Static<typeof saveKnowledgeParams>;

export function createSaveKnowledgeTool(): ToolDefinition<TSchema, unknown> {
	return {
		name: "save_knowledge",
		label: "记住知识",
		description:
			"记住客户经理要求沉淀的经验知识，存入个人知识库或客户洞察。当经理说「记住」「记下来」「记一下这个经验」时调用。",
		promptSnippet:
			"save_knowledge(content, category?, customer_id?) - 记住一条可复用经验",
		parameters: saveKnowledgeParams as TSchema,
		async execute(
			_toolCallId: string,
			params: SaveKnowledgeParams,
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: unknown,
		) {
			const ctxObj = ctx as { managerId?: string };
			const managerId =
				ctxObj?.managerId || process.env.FINANCE_DEFAULT_MANAGER || "MGR_001";
			const customerId = params.customer_id;

			try {
				const category = guessCategory(params.category, params.content);

				// 客户画像（customer_id 传入时拉取，失败降级为无画像提取）
				let customer: CustomerProfile | undefined;
				if (customerId) {
					try {
						customer = await backendGet<CustomerProfile>(
							`/api/customers/${encodeURIComponent(customerId)}/profile`,
							managerId,
						);
					} catch {
						customer = undefined;
					}
				}

				// 去重参考：现有知识库全文 + 待确认(pending)建议（避免重复提取）+ 现有洞察列表
				let existingKnowledge = "";
				if (customerId) {
					try {
						const res = await backendGet<{ content?: string }>(
							"/api/knowledge",
							managerId,
						);
						existingKnowledge = typeof res?.content === "string" ? res.content : "";
					} catch {
						existingKnowledge = "";
					}
				}
				// 未及时采纳的建议也要参与去重：pending 虽未写入知识库，但已提取过
				const pending = await backendGet<Array<{ content?: string }>>(
					"/api/knowledge/pending",
					managerId,
				).catch(() => []);
				const pendingKnowledge = (pending ?? [])
					.map((p) => p.content ?? "")
					.filter(Boolean)
					.join("\n");
				if (pendingKnowledge) {
					existingKnowledge = existingKnowledge
						? `${existingKnowledge}\n${pendingKnowledge}`
						: pendingKnowledge;
				}
				const existingInsights = customerId
					? await backendReadInsights(customerId, managerId)
					: [];

				const result = await extractKnowledge(
					{
						category,
						conversation: params.content,
						customer: customer ?? EMPTY_CUSTOMER,
						existingKnowledge,
						existingInsights,
						managerId,
					},
					resolvePiAgentDir(),
				);

				if (result.isEmpty) {
					return {
						content: [
							{ type: "text" as const, text: "该经验已存在于知识库中，无需重复记录。" },
						],
						details: { success: true, category, isEmpty: true },
					};
				}

				if (category === "customerInsight") {
					if (!customerId) {
						return {
							content: [
								{ type: "text" as const, text: "客户洞察需要指定客户（customer_id）后才能写入。" },
							],
							details: { success: false, category, error: "缺少 customer_id" },
						};
					}
					await backendWriteInsight(
						customerId,
						{ content: result.content, tags: result.tags, source: "llm" },
						managerId,
					);
				} else {
					const field = CATEGORY_TO_FIELD[category] ?? "talkTemplates";
					await mergeIntoKnowledge(managerId, field, result.content);
				}

				return {
					content: [
						{ type: "text" as const, text: `已记住：${result.summary || result.content}` },
					],
					details: { success: true, category, isEmpty: false },
				};
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				return {
					content: [
						{ type: "text" as const, text: `记住知识失败：${msg}` },
					],
					details: { success: false, error: msg },
				};
			}
		},
	};
}
