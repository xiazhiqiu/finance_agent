/**
 * pi-gateway SSE 服务入口
 *
 * 提供 HTTP POST + SSE 流式响应，替代 OpenClaw WebSocket Gateway。
 * 前端通过 fetch + ReadableStream 消费 SSE 事件。
 *
 * 本文件仅保留 createServer + 路由分发 + 启动，handler 实现在 ./handlers.ts。
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentSessionManager } from "./agent-session.ts";
import {
	handleAgentRun,
	handleBatchInsight,
	handleWorkflowSync,
	handleExtractInsight,
	handleKnowledgeSuggest,
	handleKnowledgeCandidates,
	handleCaseSearch,
	handleListSessions,
	handleSessionsBatchPlan,
	handleGetSessionMessages,
	handleSessionCompact,
	handleDeleteSession,
	handleMarketBriefGenerate,
	type HandlerContext,
} from "./handlers.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FINANCE_API_URL = process.env.FINANCE_API_URL ?? "http://127.0.0.1:3001";
const PORT = parseInt(process.env.PI_GATEWAY_PORT ?? "18789", 10);
const PI_AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(__dirname, "..", "..", ".pi");

const sessionManager = new AgentSessionManager(PI_AGENT_DIR, FINANCE_API_URL);
const ctx: HandlerContext = { sessionManager, piAgentDir: PI_AGENT_DIR };

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
	// CORS
	const origin = req.headers.origin;
	const allowedOrigins = ["http://127.0.0.1:4174", "http://localhost:4174", "http://127.0.0.1:4175", "http://localhost:4175"];
	if (origin && allowedOrigins.includes(origin)) {
		res.setHeader("Access-Control-Allow-Origin", origin);
	}
	res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
	res.setHeader("Access-Control-Allow-Headers", "Content-Type");

	if (req.method === "OPTIONS") {
		res.writeHead(204);
		res.end();
		return;
	}

	// 健康检查
	if (req.method === "GET" && req.url === "/health") {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ ok: true, service: "pi-gateway" }));
		return;
	}

	// Agent 运行
	if (req.method === "POST" && req.url === "/api/agent/run") {
		await handleAgentRun(ctx, req, res);
		return;
	}

	// M2: 批量洞察生成入口
	if (req.method === "POST" && req.url === "/api/insight/batch") {
		await handleBatchInsight(ctx, req, res);
		return;
	}

	// M3: 非流式 workflow 接口（供 backend scheduler 批量调用）
	if (req.method === "POST" && req.url === "/api/workflow/run") {
		await handleWorkflowSync(ctx, req, res);
		return;
	}

	// M4: 从被接受的方案中提取洞察
	if (req.method === "POST" && req.url === "/api/insight/extract") {
		await handleExtractInsight(ctx, req, res);
		return;
	}

	// M4: 知识库沉淀建议
	if (req.method === "POST" && req.url === "/api/knowledge/suggest") {
		await handleKnowledgeSuggest(ctx, req, res);
		return;
	}

	// M5.2: 记忆沉淀候选分析
	if (req.method === "POST" && req.url === "/api/knowledge/candidates") {
		await handleKnowledgeCandidates(ctx, req, res);
		return;
	}

	// M0: 案例检索（基于客户画像相似度）
	if (req.method === "POST" && req.url === "/api/case-store/search") {
		await handleCaseSearch(ctx, req, res);
		return;
	}

	// M3: 批量会话内方案生成（供 backend scheduler 批量调用）
	if (req.method === "POST" && req.url === "/api/sessions/batch-plan") {
		await handleSessionsBatchPlan(ctx, req, res);
		return;
	}

	// M5: 历史会话列表
	if (req.method === "GET" && req.url === "/api/sessions") {
		await handleListSessions(ctx, req, res);
		return;
	}

	// M6: 手动压缩会话（SDK compaction）
	if (req.method === "POST" && req.url?.match(/^\/api\/sessions\/([^/]+)\/compact$/)) {
		await handleSessionCompact(ctx, req, res);
		return;
	}

	// M6: 删除会话（级联清理对话历史目录）
	if (req.method === "DELETE" && req.url?.match(/^\/api\/sessions\/[^/]+$/)) {
		await handleDeleteSession(ctx, req, res);
		return;
	}

	// M5: 历史会话消息
	if (req.method === "GET" && req.url?.startsWith("/api/sessions/")) {
		await handleGetSessionMessages(ctx, req, res);
		return;
	}

	// 市场简报生成（供 backend scheduler 定时/手动触发）
	if (req.method === "POST" && req.url === "/api/market-brief/generate") {
		await handleMarketBriefGenerate(ctx, req, res);
		return;
	}

	res.writeHead(404, { "Content-Type": "application/json" });
	res.end(JSON.stringify({ error: "接口不存在" }));
});

server.listen(PORT, "127.0.0.1", () => {
	console.log(`[pi-gateway] SSE 服务已启动: http://127.0.0.1:${PORT}`);
	console.log(`[pi-gateway] Agent 目录: ${PI_AGENT_DIR}`);
	console.log(`[pi-gateway] 业务后端: ${FINANCE_API_URL}`);
});