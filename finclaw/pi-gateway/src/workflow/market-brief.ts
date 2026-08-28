/**
 * 市场简报生成（方案 A：周期性预生成，全局共享）
 *
 * 由 backend scheduler 定时触发 POST /api/market-brief/generate：
 * 复用 runLlmJsonOnce 无工具单轮调用，systemPromptOverride 注入"市场分析助手"人设，
 * 输出 { "content": "简报文本" } JSON；校验非空与长度后由调用方写入 market_brief.json。
 *
 * 简报面向方案生成 LLM 叶子（非客户），不套用话术合规约束；
 * 内容对齐 .pi/skills/market-analysis.md 的利率/权益/汇率三维框架。
 */

import { runLlmJsonOnce } from "./llm-json.ts";

/** 系统提示词：市场分析助手人设（纯文本简报，JSON 包裹输出） */
const MARKET_BRIEF_SYSTEM_PROMPT = [
	"你是银行市场分析助手。你基于通用金融知识生成简洁的宏观市场环境简报，",
	"供银行客户经理为客户生成资产配置方案时参考。",
	"不调用任何工具，只输出一个 JSON 对象，不加解释或代码围栏。",
].join("");

/** 简报内容长度上限（超出即视为生成失败） */
const MAX_CONTENT_LENGTH = 600;

/**
 * 构造市场简报生成 prompt。
 * 维度对齐 .pi/skills/market-analysis.md：利率环境 / 权益市场 / 汇率趋势 / 配置含义。
 */
export function buildMarketBriefPrompt(): string {
	const today = new Date().toISOString().slice(0, 10);
	return [
		`今天是 ${today}。请生成一份当前宏观市场环境简报，用于银行客户经理为客户生成资产配置方案时参考。`,
		"",
		"按以下维度组织（纯文本段落，不要 Markdown 标题）：",
		"- 利率环境：当前利率周期判断（降息/加息/平稳）及对固收类产品配置的含义",
		"- 权益市场：当前权益市场状态（震荡/上涨/下跌）及对权益类配置的含义",
		"- 汇率趋势：主要货币汇率趋势及对外币资产配置的含义（无显著变化可一句带过）",
		"- 配置含义：当前环境下保守型、稳健型、进取型客户各适合优先配置哪类产品",
		"",
		"要求：",
		"- 全文 100-300 字；基于通用金融常识，不编造具体数据、指数点位或事件",
		"- 表述客观、克制，不使用营销化语言",
		'只输出一个 JSON 对象，结构为 { "content": "简报全文" }，不加解释或代码围栏。',
	].join("\n");
}

/**
 * 生成市场简报。
 * @param piAgentDir pi 根目录（.pi/），SDK 从中读 auth.json 与 models.json
 * @returns 校验通过的简报文本
 */
export async function runGenerateMarketBrief(piAgentDir: string): Promise<string> {
	const { parsed, rawText } = await runLlmJsonOnce(
		piAgentDir,
		MARKET_BRIEF_SYSTEM_PROMPT,
		buildMarketBriefPrompt(),
		"market-brief",
	);
	const content =
		parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof (parsed as { content?: unknown }).content === "string"
			? (parsed as { content: string }).content.trim()
			: "";
	if (!content) {
		console.error("[market-brief] 生成失败：输出为空或非 { content } 结构", { rawText: rawText.slice(0, 200) });
		throw new Error("市场简报生成失败：输出为空");
	}
	if (content.length > MAX_CONTENT_LENGTH) {
		console.error(`[market-brief] 生成失败：超出长度上限 ${MAX_CONTENT_LENGTH} 字（实际 ${content.length}）`);
		throw new Error(`市场简报生成失败：超出长度上限（${content.length} 字）`);
	}
	return content;
}
