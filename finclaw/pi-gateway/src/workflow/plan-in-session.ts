/**
 * 会话内方案生成编排
 *
 * 在给定 sessionKey 的正式 AgentSession 内 runPrompt（复用 AgentSessionManager.runPrompt，
 * 含稳定前缀注入、会话创建/复用、SSE 事件分发），通过工具回调捕获
 * generate_plan / optimize_plan 的结果。
 *
 * 方案生成内核、提示词、会话管理全部复用现有链路（与前端手动生成一致），
 * 本模块不自造指令/提示词——指令由调用方传入（如前端现有「请为该客户生成一套营销方案」）。
 * 会话历史由 SDK 在 runPrompt 时自然写入 .pi/sessions/<safeKey>/。
 */

import type { AgentSessionManager } from "../agent-session.ts";
import type { WorkflowResult } from "./types.ts";

export interface PlanInSessionInput {
	sessionKey: string;
	customerId: string;
	managerId: string;
	instruction: string;
}

export interface PlanInSessionOutput {
	sessionKey: string;
	/** 方案生成结果（WorkflowResult：{ plans, complianceReport }），未捕获到时为 undefined */
	result?: WorkflowResult;
	/** 该轮 assistant 最终文本（用于排查与日志） */
	finalText?: string;
	/** 单会话失败原因（不影响其它会话） */
	error?: string;
}

/**
 * 在单个正式会话内生成方案。
 * 复用 runPrompt；从 generate_plan/optimize_plan 的 tool_result（details.result）捕获方案，
 * 不捕获 process 细节。失败转为 error 字段返回，不向上抛，保证单会话失败不牵连其它会话。
 */
export async function runPlanInSession(
	manager: AgentSessionManager,
	input: PlanInSessionInput,
): Promise<PlanInSessionOutput> {
	let result: WorkflowResult | undefined;
	let finalText = "";
	let error: string | undefined;

	try {
		await manager.runPrompt(
			input.sessionKey,
			input.instruction,
			{
				onThinking: () => {},
				onToolCall: () => {},
				onToolResult: (toolName, res) => {
					if (toolName !== "generate_plan" && toolName !== "optimize_plan") return;
					const details = (res as { details?: { result?: unknown; error?: string } } | undefined)
						?.details;
					if (details?.result) {
						result = details.result as WorkflowResult;
					} else if (details?.error) {
						error = details.error;
					}
				},
				onMessage: (delta) => {
					finalText += delta;
				},
				onFinal: (text) => {
					finalText = text;
				},
			},
			{ customerId: input.customerId, managerId: input.managerId },
		);
	} catch (err) {
		error ??= err instanceof Error ? err.message : String(err);
	}

	if (result && !result.error) {
		return { sessionKey: input.sessionKey, result, finalText };
	}
	return {
		sessionKey: input.sessionKey,
		finalText,
		error: error ?? result?.error ?? "未捕获到方案生成工具结果",
	};
}

/**
 * 受控并发地在多个正式会话内并行生成方案。
 * 单会话失败已隔离（见 runPlanInSession），此处按批切片以限制并发数。
 */
export async function runBatchPlanInSessions(
	manager: AgentSessionManager,
	items: PlanInSessionInput[],
	concurrency: number,
): Promise<PlanInSessionOutput[]> {
	const outputs: PlanInSessionOutput[] = new Array(items.length);
	const startedAt = Date.now();
	let wave = 0;
	for (let i = 0; i < items.length; i += concurrency) {
		wave += 1;
		const waveStart = Date.now();
		const slice = items.slice(i, i + concurrency);
		await Promise.all(
			slice.map((item, j) => {
				const idx = i + j;
				const t0 = Date.now();
				return runPlanInSession(manager, item).then((out) => {
					console.log(
						`[batch-plan] 客户 ${item.customerId} 完成, 耗时 ${Date.now() - t0}ms, 状态: ${out.result && !out.result.error ? "ok" : `error: ${out.error ?? ""}`}`,
					);
					outputs[idx] = out;
				});
			}),
		);
		console.log(
			`[batch-plan] wave ${wave}/${Math.ceil(items.length / concurrency)} (${slice.length} 计) 耗时 ${Date.now() - waveStart}ms; 累计 ${Date.now() - startedAt}ms`,
		);
	}
	console.log(
		`[batch-plan] 总 ${items.length} 计完成, 共 ${Date.now() - startedAt}ms, 并发 ${concurrency}`,
	);
	return outputs;
}
