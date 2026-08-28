/**
 * 客户级会话摘要工作流
 *
 * 每轮对话结束后，聚合会话消息生成/刷新客户摘要
 * （preferences/adoptedPlans/concerns/opportunities/raw），PUT 到 backend，
 * 供后续会话的稳定前缀注入使用。
 */

import { backendGet } from "../tools/backend-http.ts";
import { runLlmJsonOnce } from "./llm-json.ts";
import { backendPutSummary } from "./backend-client.ts";

/** 依赖注入（供测试 mock 覆盖默认实现） */
export interface SummaryRefreshDeps {
	runLlmOnce?: typeof runLlmJsonOnce;
	putSummary?: typeof backendPutSummary;
	fetchExisting?: (customerId: string, managerId: string) => Promise<string | undefined>;
}

/** 摘要 system prompt（固定） */
const SUMMARY_SYSTEM_PROMPT = "你是银行客户经理的会话摘要助手。只输出 JSON，不加解释或代码围栏。";

/** 最近对话：保留条数 / 单条 content 截断长度 */
const RECENT_MESSAGE_LIMIT = 12;
const CONTENT_TRUNCATE_CHARS = 400;
/** 兜底 raw：拼接条数 / 单条截断长度 */
const FALLBACK_MESSAGE_LIMIT = 6;
const FALLBACK_TRUNCATE_CHARS = 200;

/**
 * 构建客户级会话摘要的 LLM user prompt（纯函数）。
 */
export function buildSummaryPrompt(
	existing: string | undefined,
	messages: Array<{ role: string; content: string }>,
): string {
	const sections: string[] = [];

	// 已有摘要段落（原样放入，LLM 在其基础上增量更新）
	if (existing) {
		sections.push(`## 已有摘要\n${existing}`);
	}

	// 最近对话：只保留最近 12 条，每条 content 截断 400 字符
	const recentLines = messages
		.slice(-RECENT_MESSAGE_LIMIT)
		.map(({ role, content }) => `${role}: ${content.slice(0, CONTENT_TRUNCATE_CHARS)}`);
	sections.push(`## 最近对话\n${recentLines.join("\n")}`);

	sections.push(
		[
			"## 输出要求",
			"只输出一个 JSON 对象，不加解释或代码围栏，结构：",
			'{"preferences": string[], "adoptedPlans": string[], "concerns": string[], "opportunities": string[], "raw": string}',
			"其中 raw 为 200 字以内的中文综合摘要。",
		].join("\n"),
	);

	return sections.join("\n\n");
}

/**
 * 默认实现：GET /api/customers/{id}/summary 取已有摘要的 raw 字段。
 * 404/失败降级 undefined（catch 掉，不阻塞刷新）。
 */
async function defaultFetchExisting(
	customerId: string,
	managerId: string,
): Promise<string | undefined> {
	try {
		const summary = await backendGet<{ raw?: string } | null>(
			`/api/customers/${encodeURIComponent(customerId)}/summary`,
			managerId,
		);
		return summary && typeof summary.raw === "string" ? summary.raw : undefined;
	} catch {
		return undefined;
	}
}

/** 输出无效时的兜底 raw：最近 6 条拼接（`${role}: ${content}` 每条截 200 字） */
function fallbackRaw(messages: Array<{ role: string; content: string }>): string {
	return messages
		.slice(-FALLBACK_MESSAGE_LIMIT)
		.map(({ role, content }) => `${role}: ${content.slice(0, FALLBACK_TRUNCATE_CHARS)}`)
		.join("\n");
}

/**
 * 生成/刷新客户摘要并 PUT 到 backend。
 * LLM/网络异常向上抛（由调用方 catch）。
 */
export async function runRefreshCustomerSummary(
	input: {
		customerId: string;
		managerId: string;
		messages: Array<{ role: string; content: string }>;
	},
	piAgentDir: string,
	deps?: SummaryRefreshDeps,
): Promise<void> {
	const { customerId, managerId, messages } = input;
	const runLlmOnce = deps?.runLlmOnce ?? runLlmJsonOnce;
	const putSummary = deps?.putSummary ?? backendPutSummary;
	const fetchExisting = deps?.fetchExisting ?? defaultFetchExisting;

	const existing = await fetchExisting(customerId, managerId);
	const userPrompt = buildSummaryPrompt(existing, messages);
	const { parsed } = await runLlmOnce(piAgentDir, SUMMARY_SYSTEM_PROMPT, userPrompt, "summary");

	// 输出校验：parsed 为 object 且 raw 为非空 string 才算有效
	const record = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
	const validRaw = record !== null && typeof record.raw === "string" && record.raw !== "";
	const raw = validRaw ? (record as { raw: string }).raw : fallbackRaw(messages);
	// 四个数组字段宽松收敛：非数组置空，数组内只留 string
	const pickStrings = (key: string): string[] => {
		const value = record ? record[key] : undefined;
		return Array.isArray(value) ? value.filter((t) => typeof t === "string") : [];
	};

	await putSummary(
		customerId,
		{
			preferences: pickStrings("preferences"),
			adoptedPlans: pickStrings("adoptedPlans"),
			concerns: pickStrings("concerns"),
			opportunities: pickStrings("opportunities"),
			raw,
		},
		managerId,
	);
}
