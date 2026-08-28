/**
 * pi-gateway HTTP handler 实现层
 *
 * 收纳各路由对应的 handler 实现与 HTTP 辅助（readJsonBody / sendJson / setupSSE），
 * server.ts 只保留 createServer + 路由分发 + 启动。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentSessionManager } from "./agent-session.ts";
import {
	runGeneratePlan,
	runOptimizePlan,
	createWorkflowDeps,
	type WorkflowRequest,
} from "./workflow/index.ts";
import {
	runBatchInsight,
	createInsightDeps,
	type InsightRequest,
	runExtractInsightFromPlan,
	runSuggestKnowledge,
} from "./workflow/insight-orchestrator.ts";
import { extractCandidates, type KnowledgeCandidate } from "./workflow/extractors.ts";
import { getCaseStore } from "./workflow/case-store.ts";
import { createBackendClient } from "./workflow/backend-client.ts";
import {
	runBatchPlanInSessions,
	type PlanInSessionInput,
} from "./workflow/plan-in-session.ts";
import { backendGet } from "./tools/backend-http.ts";

export interface HandlerContext {
	sessionManager: AgentSessionManager;
	piAgentDir: string;
}

/**
 * 读取请求体并 JSON.parse。解析失败抛错，由调用方捕获并返回 400。
 */
export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
	let body = "";
	for await (const chunk of req) {
		body += chunk;
	}
	return JSON.parse(body);
}

/**
 * 以 JSON 形式写出响应。
 */
export function sendJson(res: ServerResponse, status: number, data: unknown): void {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(data));
}

/**
 * 设置 SSE 响应头并返回 sendSSE 辅助函数。
 */
export function setupSSE(res: ServerResponse): (event: string, data: unknown) => void {
	res.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache",
		Connection: "keep-alive",
		"X-Accel-Buffering": "no",
	});
	return (event: string, data: unknown) => {
		res.write(`event: ${event}\n`);
		res.write(`data: ${JSON.stringify(data)}\n\n`);
	};
}

/**
 * 系统级异常统一处理：原始错误只落服务端日志，返回通用提示，不下发内部细节。
 */
export function systemErrorMessage(label: string, error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	console.error(`[handlers] ${label} 异常`, { error: message });
	return "服务内部异常，请稍后重试";
}

/**
 * Agent 运行（自由聊天，消息统一走 Pi AgentSession）。
 */
export async function handleAgentRun(ctx: HandlerContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
	let parsed: { sessionKey?: string; message?: string; customer_id?: string; manager_id?: string };
	try {
		parsed = (await readJsonBody(req)) as {
			sessionKey?: string;
			message?: string;
			customer_id?: string;
			manager_id?: string;
		};
	} catch {
		sendJson(res, 400, { error: "无效的 JSON 请求体" });
		return;
	}

	const { sessionKey, message, customer_id, manager_id } = parsed;
	if (!sessionKey || !message) {
		sendJson(res, 400, { error: "缺少 sessionKey 或 message 字段" });
		return;
	}

	// 自由聊天:原 runPrompt 路径
	const sendSSE = setupSSE(res);

	try {
		await ctx.sessionManager.runPrompt(
			sessionKey,
			message,
			{
				onThinking: () => {
					sendSSE("thinking", { status: "thinking" });
				},
				onToolCall: (toolName: string, _args: unknown) => {
					// 只下发顶层动作（工具名），不下发详细参数，避免过程细节泄露到前端
					sendSSE("tool_call", { toolName });
				},
				onToolResult: (toolName: string, result: unknown) => {
					sendSSE("tool_result", { toolName, result });
				},
				onMessage: (delta: string) => {
					sendSSE("message", { delta });
				},
				onFinal: (text: string) => {
					sendSSE("final", { text });
				},
			},
			{ customerId: customer_id, managerId: manager_id },
		);
	} catch (error) {
		// 系统级异常只落服务端日志，不下发原始错误信息到前端/助手回复
		const errorMessage = error instanceof Error ? error.message : String(error);
		console.error("[handlers] agent run 异常", { sessionKey, error: errorMessage });
		sendSSE("error", { message: "服务暂时不可用，请稍后重试。" });
	} finally {
		res.end();
	}
}

/**
 * M2: 处理批量洞察生成请求。
 * 接收 { customerIds: string[], managerId: string }，
 * 调用 insight-orchestrator 为每个客户生成 LLM 洞察并写入 backend。
 */
export async function handleBatchInsight(ctx: HandlerContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
	let parsed: { customerIds?: string[]; managerId?: string };
	try {
		parsed = (await readJsonBody(req)) as { customerIds?: string[]; managerId?: string };
	} catch {
		sendJson(res, 400, { error: "无效的 JSON 请求体" });
		return;
	}

	const { customerIds, managerId } = parsed;
	if (!Array.isArray(customerIds) || customerIds.length === 0) {
		sendJson(res, 400, { error: "缺少 customerIds 或为空" });
		return;
	}
	if (!managerId) {
		sendJson(res, 400, { error: "缺少 managerId" });
		return;
	}

	res.writeHead(200, { "Content-Type": "application/json" });

	try {
		const insightReq: InsightRequest = { customerIds, managerId };
		const deps = createInsightDeps(ctx.piAgentDir);
		const result = await runBatchInsight(insightReq, deps);
		res.end(JSON.stringify({ data: result }));
	} catch (error) {
		res.end(JSON.stringify({ error: systemErrorMessage("batch_insight", error) }));
	}
}

/**
 * M3: 非流式 workflow 接口（供 backend scheduler 批量调用）。
 * 接收 WorkflowRequest，返回普通 JSON（非 SSE），便于 backend 解析。
 */
export async function handleWorkflowSync(ctx: HandlerContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
	let workflowReq: WorkflowRequest;
	try {
		workflowReq = (await readJsonBody(req)) as WorkflowRequest;
	} catch {
		sendJson(res, 400, { error: "无效的 JSON 请求体" });
		return;
	}

	if (!workflowReq.action || !workflowReq.payload?.customer_id || !workflowReq.payload?.manager_id) {
		sendJson(res, 400, { error: "缺少 action/payload.customer_id/payload.manager_id" });
		return;
	}

	res.writeHead(200, { "Content-Type": "application/json" });

	try {
		const deps = createWorkflowDeps();
		const result = workflowReq.action === "generate_plans"
			? await runGeneratePlan(workflowReq, deps)
			: await runOptimizePlan(workflowReq, deps);
		res.end(JSON.stringify({ data: result }));
	} catch (error) {
		res.end(JSON.stringify({ error: systemErrorMessage("workflow_sync", error) }));
	}
}

/**
 * M4.1 · 从被接受的方案中提取洞察。
 * 接收 { customerId, managerId, plan }，返回 { content, tags }。
 */
export async function handleExtractInsight(ctx: HandlerContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
	let parsed: { customerId?: string; managerId?: string; plan?: unknown };
	try {
		parsed = (await readJsonBody(req)) as { customerId?: string; managerId?: string; plan?: unknown };
	} catch {
		sendJson(res, 400, { error: "无效的 JSON 请求体" });
		return;
	}

	if (!parsed.customerId || !parsed.managerId || !parsed.plan) {
		sendJson(res, 400, { error: "缺少 customerId/managerId/plan" });
		return;
	}

	res.writeHead(200, { "Content-Type": "application/json" });
	try {
		const result = await runExtractInsightFromPlan(
			{
				customerId: parsed.customerId,
				managerId: parsed.managerId,
				plan: parsed.plan as Parameters<typeof runExtractInsightFromPlan>[0]["plan"],
			},
			ctx.piAgentDir,
		);
		res.end(JSON.stringify({ data: result }));
	} catch (error) {
		res.end(JSON.stringify({ error: systemErrorMessage("extract_insight", error) }));
	}
}

/**
 * M4.2 · 知识库沉淀建议。
 * 接收 { customerId, managerId, plan }，返回 { talkTemplates, productPriority, stylePreference }。
 */
export async function handleKnowledgeSuggest(ctx: HandlerContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
	let parsed: { customerId?: string; managerId?: string; plan?: unknown };
	try {
		parsed = (await readJsonBody(req)) as { customerId?: string; managerId?: string; plan?: unknown };
	} catch {
		sendJson(res, 400, { error: "无效的 JSON 请求体" });
		return;
	}

	if (!parsed.customerId || !parsed.managerId || !parsed.plan) {
		sendJson(res, 400, { error: "缺少 customerId/managerId/plan" });
		return;
	}

	res.writeHead(200, { "Content-Type": "application/json" });
	try {
		const result = await runSuggestKnowledge(
			{
				customerId: parsed.customerId,
				managerId: parsed.managerId,
				plan: parsed.plan as Parameters<typeof runSuggestKnowledge>[0]["plan"],
			},
			ctx.piAgentDir,
		);
		res.end(JSON.stringify({ data: result }));
	} catch (error) {
		res.end(JSON.stringify({ error: systemErrorMessage("knowledge_suggest", error) }));
	}
}

/**
 * M0 · 案例检索。
 * 接收 { customerId, managerId, limit? }，基于客户画像从案例库检索相似成交案例，
 * 复用 fetchContext 中已集成的案例检索逻辑。
 */
export async function handleCaseSearch(ctx: HandlerContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
	let parsed: { customerId?: string; managerId?: string; limit?: number };
	try {
		parsed = (await readJsonBody(req)) as { customerId?: string; managerId?: string; limit?: number };
	} catch {
		sendJson(res, 400, { error: "无效的 JSON 请求体" });
		return;
	}

	if (!parsed.customerId || !parsed.managerId) {
		sendJson(res, 400, { error: "缺少 customerId/managerId" });
		return;
	}

	res.writeHead(200, { "Content-Type": "application/json" });
	try {
		const backend = createBackendClient();
		// 只取客户画像（scope="customer" 不拉 products/市场等脆弱字段，避免 404 中断检索）
		const context = await backend.fetchContext(parsed.customerId, parsed.managerId, "customer");
		const customer = context.customer;
		// 保证画像含 customerId（profile 接口返回的画像字段可能缺失标识）
		const target = { ...customer, customerId: parsed.customerId };
		const { cases, totalFound, strategy } = await getCaseStore().search(target, parsed.managerId, parsed.limit ?? 3);
		res.end(JSON.stringify({
			data: { cases, totalFound, strategy },
		}));
	} catch (error) {
		res.end(JSON.stringify({ error: systemErrorMessage("case_search", error) }));
	}
}

/**
 * M3: 批量会话内方案生成（供 backend scheduler 批量调用）。
 * 接收 { items: Array<{ sessionKey, customerId, managerId, instruction }> }，
 * 受控并发在各自正式会话内 runPrompt 生成方案（复用现有 generate_plan 工具与提示词），
 * 返回每项结果；单会话失败独立记录 error，不牵连其它会话。
 */
export async function handleSessionsBatchPlan(
	ctx: HandlerContext,
	req: IncomingMessage,
	res: ServerResponse,
): Promise<void> {
	let parsed: { items?: Array<Partial<PlanInSessionInput>> };
	try {
		parsed = (await readJsonBody(req)) as typeof parsed;
	} catch {
		sendJson(res, 400, { error: "无效的 JSON 请求体" });
		return;
	}

	const items: PlanInSessionInput[] = (parsed.items ?? []).filter(
		(item): item is PlanInSessionInput =>
			Boolean(item && item.sessionKey && item.customerId && item.managerId && item.instruction),
	);
	if (items.length === 0) {
		sendJson(res, 400, { error: "缺少有效的 items（需含 sessionKey/customerId/managerId/instruction）" });
		return;
	}

	try {
		const concurrency = Number(process.env.BATCH_PLAN_CONCURRENCY ?? "6") || 6;
		const data = await runBatchPlanInSessions(ctx.sessionManager, items, concurrency);
		sendJson(res, 200, { data });
	} catch (error) {
		sendJson(res, 500, { error: systemErrorMessage("sessions_batch_plan", error) });
	}
}

/**
 * M5: 列出所有历史会话摘要。
 */
export async function handleListSessions(ctx: HandlerContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
	try {
		const sessions = await ctx.sessionManager.listSessions();
		sendJson(res, 200, sessions);
	} catch (error) {
		sendJson(res, 500, { error: systemErrorMessage("list_sessions", error) });
	}
}

/**
 * M5: 读取指定历史会话的完整消息列表。
 * URL 形如 /api/sessions/{sessionKey}/messages。
 */
export async function handleGetSessionMessages(ctx: HandlerContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
	const match = req.url?.match(/^\/api\/sessions\/([^/]+)\/messages$/);
	if (!match) {
		sendJson(res, 400, { error: "无效的会话路径，应为 /api/sessions/{sessionKey}/messages" });
		return;
	}
	const sessionKey = decodeURIComponent(match[1]);
	try {
		const messages = await ctx.sessionManager.getSessionMessages(sessionKey);
		sendJson(res, 200, messages);
	} catch (error) {
		sendJson(res, 500, { error: systemErrorMessage("get_session_messages", error) });
	}
}

/**
 * M6: 删除指定会话（销毁内存 + 清理 jsonl 目录）。
 * URL 形如 DELETE /api/sessions/{sessionKey}。
 */
export async function handleDeleteSession(ctx: HandlerContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
	const match = req.url?.match(/^\/api\/sessions\/([^/]+)$/);
	if (!match) {
		sendJson(res, 400, { error: "无效的会话路径，应为 /api/sessions/{sessionKey}" });
		return;
	}
	const sessionKey = decodeURIComponent(match[1]);
	try {
		const deleted = ctx.sessionManager.deleteSession(sessionKey);
		sendJson(res, 200, { success: true, deleted });
	} catch (error) {
		sendJson(res, 500, { error: systemErrorMessage("delete_session", error) });
	}
}

/**
 * M6: 手动压缩会话（SDK compaction）。
 * URL 形如 /api/sessions/{sessionKey}/compact，body 可选 { customInstructions?: string }。
 */
export async function handleSessionCompact(ctx: HandlerContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
	const match = req.url?.match(/^\/api\/sessions\/([^/]+)\/compact$/);
	if (!match) {
		sendJson(res, 400, { error: "无效的会话路径，应为 /api/sessions/{sessionKey}/compact" });
		return;
	}
	const sessionKey = decodeURIComponent(match[1]);

	// body 可选：空 body 或解析失败均视为 {}，不报 400
	let body: unknown = {};
	try {
		body = await readJsonBody(req);
	} catch {
		body = {};
	}
	const raw = (body !== null && typeof body === "object" ? body : {}) as { customInstructions?: unknown };
	const customInstructions = typeof raw.customInstructions === "string" ? raw.customInstructions : undefined;

	try {
		const result = await ctx.sessionManager.compactSession(sessionKey, customInstructions);
		sendJson(res, 200, { data: result });
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		// SDK compaction 的业务错误（已压缩过/会话过小）返回 400，其余按系统异常返回 500
		if (errorMessage.includes("Already compacted") || errorMessage.includes("Nothing to compact")) {
			sendJson(res, 400, { error: errorMessage });
			return;
		}
		sendJson(res, 500, { error: systemErrorMessage("session_compact", error) });
	}
}

/**
 * M5.2 · 记忆沉淀候选分析。
 * 接收 { sessionKey, managerId, customerId }，读取该会话最近几轮对话，
 * LLM 提炼候选知识项（≤5 条），返回给前端弹窗多选确认。
 */
export async function handleKnowledgeCandidates(ctx: HandlerContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
	let parsed: { sessionKey?: string; managerId?: string; customerId?: string };
	try {
		parsed = (await readJsonBody(req)) as { sessionKey?: string; managerId?: string; customerId?: string };
	} catch {
		sendJson(res, 400, { error: "无效的 JSON 请求体" });
		return;
	}

	if (!parsed.sessionKey || !parsed.managerId || !parsed.customerId) {
		sendJson(res, 400, { error: "缺少 sessionKey/managerId/customerId" });
		return;
	}

	res.writeHead(200, { "Content-Type": "application/json" });
	try {
		// 最近 6 条（约 3 轮问答）
		const messages = await ctx.sessionManager.getSessionMessages(parsed.sessionKey);
		const recent = (messages ?? []).slice(-6);
		const conversation = recent
			.map((m) => `${m.role === "user" ? "用户" : "助手"}：${m.content ?? ""}`)
			.join("\n");

		// 现有知识库全文（去重参考）+ 未及时采纳的建议（pending，避免重复提炼）
		const backend = createBackendClient();
		const context = await backend.fetchContext(parsed.customerId, parsed.managerId);
		const pending = await backendGet<Array<{ content?: string }>>(
			"/api/knowledge/pending",
			parsed.managerId,
		).catch(() => []);
		const pendingKnowledge = (pending ?? [])
			.map((p) => p.content ?? "")
			.filter(Boolean)
			.join("\n");
		const dedupKnowledge = context.personalKnowledge
			? `${context.personalKnowledge}\n${pendingKnowledge}`
			: pendingKnowledge;

		const candidates: KnowledgeCandidate[] = await extractCandidates(
			conversation,
			dedupKnowledge,
			parsed.managerId,
			ctx.piAgentDir,
		);
		res.end(JSON.stringify({ data: candidates }));
	} catch (error) {
		res.end(JSON.stringify({ error: systemErrorMessage("extract_knowledge", error) }));
	}
}

/**
 * 市场简报生成（供 backend scheduler 定时/手动触发）。
 * 复用 workflow/market-brief.ts：无工具单轮 LLM 调用，输出 { content }。
 */
export async function handleMarketBriefGenerate(_ctx: HandlerContext, _req: IncomingMessage, res: ServerResponse): Promise<void> {
	try {
		const { runGenerateMarketBrief } = await import("./workflow/market-brief.ts");
		const content = await runGenerateMarketBrief(_ctx.piAgentDir);
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ data: { content } }));
	} catch (error) {
		res.writeHead(500, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: systemErrorMessage("market_brief_generate", error) }));
	}
}
