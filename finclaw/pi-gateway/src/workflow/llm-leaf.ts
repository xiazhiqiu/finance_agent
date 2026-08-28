/**
 * LLM 叶子节点封装
 *
 * 封装 createAgentSession 的一次性调用:临时 sessionDir、tools: []、
 * 独立系统提示(从 .pi/agents/plan-generator/AGENTS.md 读取,通过
 * DefaultResourceLoader.systemPromptOverride 注入,完全覆盖主对话 AGENTS.md)。
 * prompt 完即 dispose 并删除临时目录。LLM 无工具、无状态,只接收上下文 JSON
 * 输出 MarketingPlan 数组 JSON。
 *
 * agentDir 指向 .pi/(pi 根目录),SDK 从 .pi/auth.json 与 .pi/models.json
 * 读取模型配置(与主对话 AgentSessionManager 一致)。叶子人设隔离通过
 * systemPromptOverride 在代码层实现,而非 agentDir 子目录隔离 —— 因为
 * SDK 用 agentDir 拼 auth.json 路径,若 agentDir 指向子目录则找不到 auth.json。
 *
 * 模型注入复用 SDK 配置(与现有 AgentSessionManager 一致),不在
 * workflow 层重新对接模型 API。
 */

import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { parseJsonWithRepair } from "@earendil-works/pi-ai";
import type {
	GenerateParams,
	LlmLeaf,
	MarketingPlan,
	Product,
} from "./types.ts";
import { projectPlanContext, serializeLeafContext } from "./context-builder.ts";
import { runLlmJsonOnce } from "./llm-json.ts";

/**
 * 启发式修复 LLM 输出 JSON 的常见语法错误(缺逗号 / 尾随逗号),在
 * parseJsonWithRepair 仍无法解析时兜底使用。逐条正则针对性修复:
 *   1. 尾随逗号:逗号后(可含空白)直接跟 } / ],删除逗号
 *   2. 值结束(} / ])后紧跟 { / [ / " 时,补逗号
 *   3. 字符串值结束后紧跟 { / [ / " 时,补逗号(键后跟 : 不受影响)
 * 合法 JSON 中逗号分隔必然存在,上述"值结束 token 后直接跟值/键开始 token"
 * 的情形只会出现在缺逗号处,因此不会误伤合法输出。
 *
 * 注意:不做"数字 / true / false / null 后补逗号"的修复 —— 正则无法区分
 * 字符串内外的数字(如 productId "P001" 内的 1 会被误伤),且该场景极少见,
 * 即便发生也会由 P0 错误反馈重试兜底。
 */
function repairMissingCommas(text: string): string {
	let out = text;
	out = out.replace(/,\s*([}\]])/g, "$1");
	out = out.replace(/([}\]])[ \t\r\n]*(?={|\[|")/g, "$1,");
	out = out.replace(/"[^"\\]*(?:\\.[^"\\]*)*"[ \t\r\n]*(?={|\[|")/g, (m) => m + ",");
	return out;
}

/** 先尝试 parseJsonWithRepair,失败则启发式修复缺逗号后再试一次。 */
function tryParseJson(text: string): unknown {
	try {
		return parseJsonWithRepair(text);
	} catch {
		return parseJsonWithRepair(repairMissingCommas(text));
	}
}

/**
 * 从 LLM 文本响应中宽松提取 plans 数组。
 * 移植自前端 web/src/result-parser.ts 的 parseGenerateResult,支持:
 *   1. trim 后的裸 JSON
 *   2. ``` 代码围栏内容
 *   3. 首尾大括号截取
 *
 * 使用 pi-ai 的 parseJsonWithRepair 替代原生 JSON.parse,可修复 LLM 输出中
 * 字符串字面量内的未转义控制字符(如 markdown 字段中的实际换行)和无效转义序列;
 * 仍失败时叠加 repairMissingCommas 修复缺逗号/尾随逗号。
 */
function parsePlansFromText(text: string): MarketingPlan[] {
	const candidates: string[] = [text.trim()];
	const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map(
		(match) => match[1]?.trim() ?? "",
	);
	candidates.push(...fences.reverse());
	const firstBrace = text.indexOf("{");
	const lastBrace = text.lastIndexOf("}");
	if (firstBrace >= 0 && lastBrace > firstBrace) {
		candidates.push(text.slice(firstBrace, lastBrace + 1));
	}

	let lastError: unknown;
	for (const candidate of candidates) {
		if (!candidate) continue;
		try {
			const parsed: unknown = tryParseJson(candidate);
			if (
				parsed &&
				typeof parsed === "object" &&
				Array.isArray((parsed as { plans?: unknown }).plans)
			) {
				return (parsed as { plans: MarketingPlan[] }).plans;
			}
		} catch (error) {
			lastError = error;
		}
	}
	// 完整原始输出记录到服务端日志，便于定位 LLM 实际返回了什么；
	// 抛出的错误由上层（plan-tools）统一转成用户友好提示，不直接泄露原始输出。
	console.error("[llm-leaf] 方案 JSON 解析失败", {
		error: lastError instanceof Error ? lastError.message : String(lastError),
		rawOutput: text,
	});
	const preview = text.slice(0, 200);
	throw new Error(
		`LLM 叶子节点未返回可识别的方案 JSON: ${lastError instanceof Error ? lastError.message : "解析失败"}。原始输出前 200 字符: ${preview}`,
	);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * A1+A3: 程序回填产品展示字段与配置名称。
 * LLM 输出 products 仅含 productId + reason;此处按 productId 从上下文回填
 * name/category/subCategory/riskLevel/tenor/expectedReturn,并统一
 * allocation.products 名称为回填后的标准名称(名称不在回填集合内则抛错,
 * 由调用方走失败路径,防止前端展示与 productId 不一致的名称)。
 */
export function backfillPlanFields(
	plan: MarketingPlan,
	contextProducts: Product[],
): void {
	const byId = new Map(contextProducts.map((p) => [p.productId, p]));
	const names = new Set<string>();
	for (const item of plan.products) {
		const src = byId.get(item.productId);
		if (!src) continue; // productId 范围校验由 validatePlan 负责
		item.name = src.name;
		item.category = src.category;
		item.subCategory = src.subCategory;
		item.riskLevel = src.riskLevel;
		item.tenor = src.tenor;
		item.expectedReturn = src.expectedReturn;
		names.add(src.name);
	}
	for (const [key, entry] of Object.entries(plan.allocation ?? {})) {
		const entryObj = entry as { products?: string[] };
		if (!Array.isArray(entryObj.products)) continue; // 结构错误由 validatePlan 负责
		const fixed = entryObj.products.map((name) => {
			if (names.has(name)) return name;
			throw new Error(`方案 allocation.${key}.products 含未选产品名: ${name}`);
		});
		entryObj.products = fixed;
	}
}

/**
 * 校验单个 plan 的字段完整性与 productId 范围。
 * 缺字段或 productId 不在上下文 products 范围内时抛出。
 */
export function validatePlan(plan: unknown, contextProducts: Product[]): void {
	if (!isPlainObject(plan)) {
		throw new Error("方案必须是对象");
	}
	const required: Array<keyof MarketingPlan> = [
		"planId",
		"customerId",
		"title",
		"score",
		"tags",
		"diagnosis",
		"allocation",
		"products",
		"scripts",
		"markdown",
	];
	for (const key of required) {
		if (!(key in plan)) {
			throw new Error(`方案缺字段: ${String(key)}`);
		}
	}
	const products = (plan as { products: unknown }).products;
	if (!Array.isArray(products)) {
		throw new Error("方案 products 必须是数组");
	}
	const validProductIds = new Set(contextProducts.map((p) => p.productId));
	for (const item of products) {
		if (!isPlainObject(item)) {
			throw new Error("方案 products 项必须是对象");
		}
		const pid = (item as { productId?: unknown }).productId;
		if (typeof pid !== "string" || !validProductIds.has(pid)) {
			throw new Error(`方案 productId 不在上下文产品范围内: ${String(pid)}`);
		}
		// A1: 产品展示字段由程序回填,LLM 仅需给出选择理由
		if (typeof (item as { reason?: unknown }).reason !== "string") {
			throw new Error(`方案 products 项缺推荐理由(reason)`);
		}
	}
	// allocation 结构校验:每个类别值必须为 { pct: number, products: string[] } 对象,
	// 防止 LLM 输出 { "类别": 45, "pct": 55, "products": [...] } 的平铺错误结构
	// 导致前端渲染崩溃(见 planDetailHtml 的 allocation.products.join)。
	const allocation = (plan as { allocation: unknown }).allocation;
	if (!isPlainObject(allocation)) {
		throw new Error("方案 allocation 必须是对象");
	}
	for (const [key, value] of Object.entries(allocation)) {
		if (!isPlainObject(value)) {
			throw new Error(`方案 allocation.${key} 必须是 { pct, products } 对象`);
		}
		const entry = value as Record<string, unknown>;
		if (typeof entry.pct !== "number") {
			throw new Error(`方案 allocation.${key}.pct 必须是数字`);
		}
		if (!Array.isArray(entry.products) || !entry.products.every((p) => typeof p === "string")) {
			throw new Error(`方案 allocation.${key}.products 必须是字符串数组`);
		}
	}
}

/**
 * 构建 prompt 字符串。注入 context、mode、retryInstructions(若有)、
 * previousPlan + instruction(optimize 时)。
 */
function buildPrompt(params: GenerateParams): string {
	// plan scope 白名单投影 + 紧凑序列化;投影缺客户画像时降级为全量紧凑序列化
	let contextJson: string;
	try {
		contextJson = serializeLeafContext(projectPlanContext(params.context));
	} catch (error) {
		console.error("[llm-leaf] plan scope 上下文投影失败,降级为全量紧凑序列化", error);
		contextJson = JSON.stringify(params.context);
	}

	const lines: string[] = [
		"你是营销方案生成器。请根据以下业务上下文生成营销方案。",
		"",
		`## 模式`,
		params.mode === "generate"
			? "generate: 生成 3 套差异明显的方案"
			: "optimize: 只返回 1 套优化后的方案",
		"",
		"## 业务上下文",
		"```json",
		contextJson,
		"```",
	];

	// 市场简报已由 projectPlanContext 白名单保留在 contextJson 内，无需再独立注入

	if (params.retryInstructions && params.retryInstructions.length > 0) {
		lines.push(
			"",
			"## 重试修正指令",
			"上一轮方案未通过合规审查,请按以下修正指令逐条修正:",
			"```json",
			JSON.stringify(params.retryInstructions),
			"```",
		);
	}

	if (params.retryFeedback) {
		lines.push(
			"",
			"## 输出格式修正",
			"上一轮输出未通过解析/结构校验,请据此修正你的输出,重新生成完整结果:",
			params.retryFeedback,
		);
	}

	if (params.mode === "optimize") {
		lines.push("", "## 优化要求");
		if (params.previousPlan) {
			lines.push("目标方案:", "```json", JSON.stringify(params.previousPlan), "```");
		}
		if (params.instruction) {
			lines.push(`优化指令: ${params.instruction}`);
		}
	}

	if (params.context.similarCases && params.context.similarCases.length > 0) {
		const caseBlocks = params.context.similarCases.map((c, i) => {
			const allocationLines = Object.entries(c.allocation ?? {})
				.map(([k, v]) => `- ${k}: ${v.pct}% → ${(v.products || []).join("、")}`)
				.join("\n");
			const productLines = (c.products || [])
				.map((p) => `- **${p.name}**（${p.category}/${p.riskLevel}）：${p.reason}`)
				.join("\n");
			return [
				`### 案例 ${i + 1}：${c.title} · ${c.score} 分`,
				`诊断：${c.diagnosis}`,
				allocationLines ? `配置比例：\n${allocationLines}` : "配置比例：（无）",
				productLines ? `推荐产品：\n${productLines}` : "推荐产品：（无）",
			].join("\n");
		});
		lines.push("", "## 参考案例（相似客户的成功方案，供参考借鉴，非强制约束）", ...caseBlocks);
	}

	lines.push(
		"",
		"## 输出要求",
		"只输出一个 JSON 对象,结构为 { \"plans\": [ ...MarketingPlan ] },不加解释、Markdown 代码围栏或前后缀。",
		"严格遵守系统提示中的合规约束(违禁词黑名单、必备风险揭示语、productId 原样复制)。",
	);
	return lines.join("\n");
}

/**
 * 将解析/结构校验错误转为给 LLM 的格式修正反馈。
 * 仅包含错误消息(对 LLM 修正有指导意义),不包含完整原始输出 —— 原始输出
 * 已在 parsePlansFromText 失败路径记入服务端日志,不重复占用上下文或泄露。
 */
function formatRetryFeedback(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return `- 错误信息: ${message}\n请据此修正后重新生成完整结果,确保输出为合法 JSON、字段齐全、选品与 allocation 一致。`;
}

/**
 * 创建 LLM 叶子节点。
 *
 * @param piAgentDir pi 根目录(.pi/),SDK 从此目录读 auth.json 与 models.json
 * @param leafPromptFile 叶子人设文件路径(.pi/agents/plan-generator/AGENTS.md),
 *   内容通过 systemPromptOverride 注入,完全覆盖主对话 AGENTS.md
 * @param sessionsRoot 临时 sessionDir 的父目录(默认 <piAgentDir>/sessions/)
 */
export function createLlmLeaf(
	piAgentDir: string,
	leafPromptFile: string,
	sessionsRoot?: string,
): LlmLeaf {
	const agentDir = piAgentDir;
	const leafSessionsRoot = sessionsRoot ?? join(agentDir, "sessions");

	// 读取叶子人设内容(同步读,文件小且稳定)
	const leafSystemPrompt = existsSync(leafPromptFile)
		? readFileSync(leafPromptFile, "utf-8")
		: "";

	return {
		async generatePlans(params: GenerateParams): Promise<MarketingPlan[]> {
			const contextProducts = params.context.products ?? [];
			// P0: 解析/结构校验失败时,将错误通过 retryFeedback 反馈给 LLM 自动重试
			// 1 次(最多执行 2 次)。反馈内容不含完整原始输出,避免上下文膨胀与信息泄露。
			const maxAttempts = 2;
			let lastError: unknown;

			for (let attempt = 1; attempt <= maxAttempts; attempt++) {
				const attemptParams: GenerateParams =
					attempt === 1
						? params
						: { ...params, retryFeedback: formatRetryFeedback(lastError) };

				// 复用 runLlmJsonOnce 的临时 session 全流程(建目录 → createAgentSession
				// tools:[] → 订阅收集 → 兜底取 state → 清理),systemPrompt 由叶子人设覆盖。
				// 每次尝试使用独立临时 session,互不影响。
				const { rawText } = await runLlmJsonOnce(
					agentDir,
					leafSystemPrompt,
					buildPrompt(attemptParams),
					"leaf",
					leafSessionsRoot,
				);

				try {
					// 解析 + 回填 + 校验（context 可能为部分提供，products 缺省视为空列表）
					// A1/A3: 先按 productId 回填产品展示字段与配置名称,再校验结构
					const plans = parsePlansFromText(rawText);
					for (const plan of plans) {
						backfillPlanFields(plan, contextProducts);
						validatePlan(plan, contextProducts);
					}

					// optimize 模式校验长度为 1
					if (params.mode === "optimize" && plans.length !== 1) {
						throw new Error(
							`optimize 模式必须且只能返回 1 套方案,实际返回 ${plans.length} 套`,
						);
					}

					return plans;
				} catch (error) {
					lastError = error;
					if (attempt >= maxAttempts) throw error;
					console.warn(
						`[llm-leaf] 方案解析/结构校验失败(第 ${attempt} 次),进入错误反馈重试`,
						{ error: error instanceof Error ? error.message : String(error) },
					);
				}
			}
			// 理论不可达(循环内已抛),兜底避免"未初始化变量"告警
			throw lastError;
		},
	};
}
