/**
 * 历史会话"一问一答"聚合纯函数
 *
 * jsonl 会话中，工具调用步骤、工具 JSON 摘要会被拆成多条 message 平铺存储。
 * 这里将其按"一问一答"聚合：每条 user 消息与其后所有 assistant/toolResult
 * 回复合并为一条回答，避免 UI 中工具步骤被拆成多条气泡展示。
 */

import { contentText } from "@earendil-works/pi-ai";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { FileEntry } from "@earendil-works/pi-coding-agent";

/** 聚合后的一条会话消息 */
export interface AggregatedMessage {
	role: string;
	content: string;
	timestamp?: string;
	plans?: unknown;
}

/**
 * 移除文本开头的 `[会话上下文] ...` 前缀行（首行以 `[会话上下文]` 开头，
 * 后面通常跟一个空行）。例如：
 * `"[会话上下文] customer: CUST_001, manager: MGR_001\n\n你好"` → `"你好"`。
 */
export function stripContextPrefix(text: string): string {
	const lines = text.split("\n");
	if (lines.length === 0 || !lines[0].trim().startsWith("[会话上下文]")) {
		return text;
	}
	// 跳过前缀行后的空行
	let i = 1;
	while (i < lines.length && lines[i].trim() === "") {
		i++;
	}
	return lines.slice(i).join("\n");
}

/**
 * 将 parseSessionEntries 返回的条目数组聚合为"一问一答"消息列表。
 * - 只处理 type === "message" 且 message.content 存在的条目；
 * - user 条目经 stripContextPrefix 作为用户消息输出；
 * - 其后 role 为 assistant / toolResult 的条目并入本轮回答（用 \n 拼接）；
 * - 完整方案数据通过工具结果的 details 通道透传，不在此处从文本解析；
 *   generate_plan / optimize_plan 的 toolResult 摘要文本原样保留；
 * - 遇到下一条 user 条目结束上一轮；所有 user 条目都输出。
 */
export function aggregateSessionEntries(entries: FileEntry[]): AggregatedMessage[] {
	const result: AggregatedMessage[] = [];
	let currentUser: AggregatedMessage | null = null;
	let parts: string[] = [];
	let plans: unknown | undefined;
	let lastTimestamp: string | undefined;

	for (const entry of entries) {
		if (entry.type !== "message" || !("content" in entry.message)) {
			continue;
		}
		const { role, content } = entry.message;
		if (role === "user") {
			if (currentUser) {
				pushTurn(result, currentUser, parts, plans, lastTimestamp);
			}
			currentUser = { role: "user", content: stripContextPrefix(contentText(content, "")) };
			parts = [];
			plans = undefined;
			lastTimestamp = entry.timestamp;
		} else if (role === "assistant" || role === "toolResult") {
			if (!currentUser) {
				continue;
			}
			const text = contentText(content, "");
			if (text.trim() !== "") {
				parts.push(text);
			}
			// 完整方案数据通过工具结果的 details 通道透传：
			// generate_plan / optimize_plan 的 toolResult 携带 details.result（含 plans 数组），
			// 聚合时取出挂到本轮回答，供前端直接还原方案卡片。
			if (role === "toolResult") {
				const toolResult = entry.message as ToolResultMessage & {
					details?: { result?: { plans?: unknown[] } };
				};
				if (
					(toolResult.toolName === "generate_plan" || toolResult.toolName === "optimize_plan") &&
					toolResult.details?.result &&
					Array.isArray(toolResult.details.result.plans) &&
					toolResult.details.result.plans.length > 0
				) {
					plans = toolResult.details.result;
				}
			}
			lastTimestamp = entry.timestamp;
		}
	}
	if (currentUser) {
		pushTurn(result, currentUser, parts, plans, lastTimestamp);
	}
	return result;
}

function pushTurn(
	result: AggregatedMessage[],
	user: AggregatedMessage,
	parts: string[],
	plans: unknown | undefined,
	lastTimestamp: string | undefined,
): void {
	result.push(user);
	if (parts.length === 0 && !plans) {
		return;
	}
	const assistant: AggregatedMessage = {
		role: "assistant",
		content: parts.join("\n"),
		timestamp: lastTimestamp ?? user.timestamp,
	};
	if (plans) {
		assistant.plans = plans;
	}
	result.push(assistant);
}
