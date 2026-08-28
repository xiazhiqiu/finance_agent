/**
 * 一次性 LLM JSON 调用原子
 *
 * 抽取自 insight-orchestrator 的 createInsightLlm.generateInsight 与 M4 的
 * runLlmJson 两处高度重复逻辑，封装"建临时 sessionDir → SessionManager.create →
 * DefaultResourceLoader + systemPromptOverride → createAgentSession(tools: []) →
 * 订阅收集 assistant text → session.prompt → 兜底取 state → parseJsonWithRepair →
 * 清理 sessionDir"完整流程，作为共享原子供两处复用。
 */

import { join, dirname } from "node:path";
import { mkdirSync, existsSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	type AgentSession,
	type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { contentText, parseJsonWithRepair } from "@earendil-works/pi-ai";

export interface LlmJsonOnceResult {
	/** parseJsonWithRepair 之后的宽松解析结果 */
	parsed: unknown;
	/** 原始 assistant 文本（用于错误信息） */
	rawText: string;
}

/**
 * 执行一次无工具 LLM JSON 调用，返回解析结果与原始文本。
 * 成功/失败都释放 session 并删除临时 sessionDir。
 */
export async function runLlmJsonOnce(
	agentDir: string,
	systemPrompt: string,
	userPrompt: string,
	sessionPrefix: string,
	sessionsRoot?: string,
): Promise<LlmJsonOnceResult> {
	const leafSessionsRoot = sessionsRoot ?? join(agentDir, "sessions");
	const ts = Date.now();
	const rand = randomUUID().slice(0, 8);
	const sessionDir = join(leafSessionsRoot, `${sessionPrefix}-${ts}-${rand}`);
	if (!existsSync(sessionDir)) {
		mkdirSync(sessionDir, { recursive: true });
	}

	const sessionManager = SessionManager.create(agentDir, sessionDir);
	const cwd = dirname(agentDir);

	let session: AgentSession | undefined;
	try {
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			systemPromptOverride: () => systemPrompt,
			appendSystemPromptOverride: () => [],
		});
		await resourceLoader.reload();

		const result = await createAgentSession({
			cwd,
			agentDir,
			tools: [],
			sessionManager,
			resourceLoader,
			// 强制关闭思考模式:leaf 会话的 settings 读取在 gateway 进程内可能
			// fallback 到 DEFAULT_THINKING_LEVEL(medium)→clamp 为 high,导致
			// DeepSeek 思考模式开启(reasoning tokens 数百),生成耗时暴涨 7-9 倍。
			// 显式传 "off" 绕开 settings 解析,保证 LLM 叶子只做无思考的 JSON 生成。
			thinkingLevel: "off",
		});
		session = result.session;

		let assistantText = "";
		const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
			if (event.type === "message_end" && event.message.role === "assistant") {
				const text = contentText(event.message.content, "");
				if (text) assistantText = text;
				// 诊断日志:打印该次 LLM 调用的 usage 与 thinkingLevel(排查生成慢)
				const usage = (event.message as { usage?: unknown }).usage;
				console.log(
					`[llm-json] message_end usage=${JSON.stringify(usage)} thinkingLevel=${session.thinkingLevel}`,
				);
			}
		});

		try {
			await session.prompt(userPrompt);
		} finally {
			unsubscribe();
		}

		// 兜底:若 message_end 未捕获,从 state 提取最后一条 assistant 消息
		if (!assistantText) {
			const state = session.state;
			const lastMessage = state.messages[state.messages.length - 1];
			if (lastMessage && lastMessage.role === "assistant") {
				assistantText = contentText(lastMessage.content, "");
			}
		}

		// 剥离可能出现的 markdown 代码围栏（LLM 有时会忽略"不加代码围栏"的指令）
		const cleaned = stripCodeFences(assistantText.trim());
		// 解析失败不在此抛原生 JSON.parse 错误（否则会拦住调用方的宽松兜底解析），
		// 而是返回 parsed=undefined + 保留 rawText，由各调用方自行容错。
		let parsed: unknown;
		try {
			parsed = parseJsonWithRepair(cleaned);
		} catch {
			parsed = undefined;
		}
		return {
			parsed,
			rawText: assistantText,
		};
	} finally {
		try {
			session?.dispose();
		} catch {
			// 忽略
		}
		try {
			rmSync(sessionDir, { recursive: true, force: true });
		} catch {
			// 忽略
		}
	}
}

/**
 * 剥离 LLM 输出中可能出现的 markdown 代码围栏（```json / ```）.
 * 只处理首尾围栏，不影响正文中的反引号。
 */
function stripCodeFences(text: string): string {
	const trimmed = text.trim();
	// 以 ``` 开头（可能带 json 标记）
	const fenceMatch = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)```\s*$/);
	if (fenceMatch) return fenceMatch[1].trim();
	return trimmed;
}

/**
 * 通用 LLM JSON 调用（一次性 session），返回 parseJsonWithRepair 结果。
 * 兼容原 insight-orchestrator 的 runLlmJson 对外签名。
 */
export async function runLlmJson(
	piAgentDir: string,
	systemPrompt: string,
	userPrompt: string,
): Promise<unknown> {
	const { parsed } = await runLlmJsonOnce(piAgentDir, systemPrompt, userPrompt, "m4");
	return parsed;
}