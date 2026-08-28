/**
 * AgentSession 管理器
 *
 * 封装 pi-coding-agent SDK 的 createAgentSession，
 * 提供 per-sessionKey 的会话管理和 SSE 事件回调。
 */

import { join, resolve, dirname } from "node:path";
import { mkdirSync, existsSync, readdirSync, readFileSync, statSync, rmSync } from "node:fs";
import {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	parseSessionEntries,
	type AgentSession,
	type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { contentText } from "@earendil-works/pi-ai";
import { createCustomTools } from "./tools/customer-analyze.ts";
import { safeKey } from "./tools/safe-key.ts";
import { backendGet } from "./tools/backend-http.ts";
import {
	buildChatStablePrefix,
	type ChatPrefixCustomer,
} from "./workflow/context-builder.ts";
import { aggregateSessionEntries, stripContextPrefix } from "./session-aggregate.ts";
import { runRefreshCustomerSummary } from "./workflow/customer-summary.ts";

export interface PromptCallbacks {
	onThinking: () => void;
	onToolCall: (toolName: string, args: unknown) => void;
	onToolResult: (toolName: string, result: unknown) => void;
	onMessage: (delta: string) => void;
	onFinal: (text: string) => void;
}

/**
 * 判断是否启用 Agent 运行沙箱。
 *
 * FINANCE_AGENT_SANDBOX 缺省启用（未设置/"1" 均视为启用），显式设 "0" 关闭，
 * 便于部署时一键回退到可读本地文件的模式。
 *
 * 说明：SDK 无内置沙箱，这里通过工具级门控实现——
 * 启用时用 noTools:"builtin" 禁用内置文件系统工具（read/ls/grep/find/edit/write），
 * 仅保留自定义后端 HTTP 业务工具，阻止 agent 读取本地开发源码。
 */
export function isAgentSandboxEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return (env.FINANCE_AGENT_SANDBOX ?? "1") !== "0";
}

/** 历史会话摘要 */
export interface SessionSummary {
	sessionId: string; // safeKey
	title: string; // 首条用户消息或系统标题
	messageCount: number;
	lastActivity: string; // ISO 日期字符串
	lastMessage: string; // 最近一条有效消息
}

/** 历史会话单条消息 */
export interface SessionMessage {
	role: string;
	content: string;
	timestamp?: string;
	/** 本轮回答解析出的方案数据（如有） */
	plans?: unknown;
}

export class AgentSessionManager {
	private readonly agentDir: string;
	private readonly financeApiUrl: string;
	private readonly sessions = new Map<string, AgentSession>();
	private readonly sessionsDir: string;
	/** 客户摘要上次刷新时间（按 customerId 节流） */
	private readonly summaryRefreshAt = new Map<string, number>();

	constructor(agentDir: string, financeApiUrl: string) {
		this.agentDir = resolve(agentDir);
		this.financeApiUrl = financeApiUrl;
		this.sessionsDir = join(this.agentDir, "sessions");
		if (!existsSync(this.sessionsDir)) {
			mkdirSync(this.sessionsDir, { recursive: true });
		}
	}

	/**
	 * 运行一次 prompt，通过回调将事件流式推给调用方。
	 * 会话按 sessionKey 复用，支持多轮对话。
	 * @param context 会话上下文（可选）：客户/经理标识与业务背景（画像/摘要/知识库）
	 *   在会话创建时经系统提示稳定前缀注入，不再改写用户消息。
	 */
	async runPrompt(
		sessionKey: string,
		message: string,
		callbacks: PromptCallbacks,
		context?: { customerId?: string; managerId?: string },
	): Promise<void> {
		const session = await this.getOrCreateSession(sessionKey, context);

		// 订阅事件
		let assistantText = "";
		const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
			this.handleEvent(event, callbacks, (text: string) => {
				assistantText = text;
			});
		});

		try {
			// 业务上下文经系统提示稳定前缀注入（见 getOrCreateSession），消息保持原样
			await session.prompt(message);
		} finally {
			unsubscribe();
		}

		// 提取最终文本：取最后一条 assistant 消息的文本
		const state = session.state;
		const lastMessage = state.messages[state.messages.length - 1];
		if (lastMessage && lastMessage.role === "assistant") {
			const text = contentText(lastMessage.content, "");
			assistantText = text;
		}

		callbacks.onFinal(assistantText);

		// 节流刷新客户级会话摘要（fire-and-forget）
		this.scheduleSummaryRefresh(sessionKey, context);
	}

	/**
	 * 节流刷新客户级会话摘要（默认 10 分钟一次，FINANCE_SUMMARY_REFRESH_MS 可调）。
	 * fire-and-forget：失败仅打日志，不阻塞主流程。
	 */
	private scheduleSummaryRefresh(
		sessionKey: string,
		context?: { customerId?: string; managerId?: string },
	): void {
		const customerId = context?.customerId;
		if (!customerId) {
			return;
		}
		const interval = Number(process.env.FINANCE_SUMMARY_REFRESH_MS ?? "600000") || 600000;
		if (Date.now() - (this.summaryRefreshAt.get(customerId) ?? 0) < interval) {
			return;
		}
		this.summaryRefreshAt.set(customerId, Date.now());
		const managerId =
			context?.managerId || process.env.FINANCE_DEFAULT_MANAGER || "MGR_001";
		void this.doRefreshSummary(sessionKey, customerId, managerId);
	}

	private async doRefreshSummary(
		sessionKey: string,
		customerId: string,
		managerId: string,
	): Promise<void> {
		try {
			const messages = await this.getSessionMessages(sessionKey);
			await runRefreshCustomerSummary({ customerId, managerId, messages }, this.agentDir);
		} catch (error) {
			console.error("[agent-session] 客户摘要刷新失败", { customerId, error });
		}
	}

	/**
	 * 手动压缩指定会话（SDK compaction），返回压缩结果。
	 * 订阅事件以输出 compaction_start/end 日志（回调为 no-op，压缩不产生前端流）。
	 */
	async compactSession(sessionKey: string, customInstructions?: string): Promise<unknown> {
		const session = await this.getOrCreateSession(sessionKey);
		const noopCallbacks: PromptCallbacks = {
			onThinking: () => {},
			onToolCall: () => {},
			onToolResult: () => {},
			onMessage: () => {},
			onFinal: () => {},
		};
		const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
			this.handleEvent(event, noopCallbacks, () => {});
		});
		try {
			return await session.compact(customInstructions);
		} finally {
			unsubscribe();
		}
	}

	private handleEvent(
		event: AgentSessionEvent,
		callbacks: PromptCallbacks,
		setFinalText: (text: string) => void,
	): void {
		switch (event.type) {
			case "turn_start":
				callbacks.onThinking();
				break;

			case "tool_execution_start":
				callbacks.onToolCall(event.toolName, event.args);
				break;

			case "tool_execution_end":
				callbacks.onToolResult(event.toolName, event.result);
				break;

			case "message_update": {
				// 流式文本片段 - 只传递 text_delta，过滤 thinking_delta 和 toolcall_delta
				const { assistantMessageEvent } = event;
				if (assistantMessageEvent && "delta" in assistantMessageEvent) {
					// 只处理 text_delta 类型的事件，避免思考细节和工具调用delta展示在前端
					if ((assistantMessageEvent as { type: string }).type === "text_delta") {
						const delta = (assistantMessageEvent as { delta?: string }).delta;
						if (delta) {
							callbacks.onMessage(delta);
						}
					}
				}
				break;
			}

			case "message_end": {
				if (event.message.role === "assistant") {
					const text = contentText(event.message.content, "");
					if (text) {
						setFinalText(text);
					}
				}
				const usage = (event.message as { usage?: { input: number; output: number; cacheRead: number; cacheWrite: number } }).usage;
				if (usage) {
					console.log("[agent-session] usage", usage);
				}
				break;
			}

			case "compaction_start":
				console.log("[agent-session] compaction_start", { reason: event.reason });
				break;

			case "compaction_end":
				console.log("[agent-session] compaction_end", { reason: event.reason, aborted: event.aborted, errorMessage: event.errorMessage });
				break;
		}
	}

	/**
	 * 构建会话稳定前缀（客户画像/摘要/知识库，注入系统提示尾部，对前缀缓存友好）。
	 * 三路并发拉取，单路失败降级为 null；整体异常时退化为仅含标识的极简前缀，不阻塞会话。
	 */
	private async buildStablePrefix(
		context?: { customerId?: string; managerId?: string },
	): Promise<string> {
		const customerId = context?.customerId;
		if (!customerId) {
			return "";
		}
		const managerId =
			context?.managerId || process.env.FINANCE_DEFAULT_MANAGER || "MGR_001";
		try {
			const [profile, summary, knowledge] = await Promise.all([
				backendGet<Record<string, unknown>>(
					`/api/customers/${encodeURIComponent(customerId)}/profile`,
					managerId,
				).catch(() => null),
				backendGet<{ raw?: string } | null>(
					`/api/customers/${encodeURIComponent(customerId)}/summary`,
					managerId,
				).catch(() => null),
				backendGet<{ content?: string } | Record<string, unknown>>(
					"/api/knowledge",
					managerId,
				).catch(() => null),
			]);

			// 白名单投影：profile 响应现已附带 tasks 与合并 tags，禁止透传，未定义字段不取
			let customer: ChatPrefixCustomer | null = null;
			if (profile) {
				customer = {
					customerId: typeof profile.customerId === "string" ? profile.customerId : customerId,
					name: typeof profile.name === "string" ? profile.name : "",
					segment: typeof profile.segment === "string" ? profile.segment : undefined,
					riskTolerance:
						typeof profile.riskTolerance === "string" ? profile.riskTolerance : undefined,
					aum: typeof profile.aum === "number" ? profile.aum : undefined,
					lifeCycleStage:
						typeof profile.lifeCycleStage === "string" ? profile.lifeCycleStage : undefined,
					preferences: Array.isArray(profile.preferences)
						? profile.preferences.filter((p): p is string => typeof p === "string")
						: undefined,
				};
			}

			const summaryRaw =
				summary && typeof summary.raw === "string" ? summary.raw : undefined;
			const knowledgeContent =
				typeof knowledge === "string"
					? knowledge
					: knowledge && typeof knowledge.content === "string"
						? knowledge.content
						: "";

			return buildChatStablePrefix({
				customerId,
				managerId,
				customer,
				summary: summaryRaw,
				knowledge: knowledgeContent,
			});
		} catch (error) {
			console.error(`[agent-session] 稳定前缀构建降级`, error);
			return buildChatStablePrefix({ customerId, managerId });
		}
	}

	private async getOrCreateSession(
		sessionKey: string,
		context?: { customerId?: string; managerId?: string },
	): Promise<AgentSession> {
		let session = this.sessions.get(sessionKey);
		if (session) {
			return session;
		}

		// 为每个 sessionKey 创建独立的会话目录
		const dirKey = safeKey(sessionKey);
		const sessionDir = join(this.sessionsDir, dirKey);
		if (!existsSync(sessionDir)) {
			mkdirSync(sessionDir, { recursive: true });
		}

		// 重启恢复：目录存在 jsonl 历史时经 continueRecent 恢复最近会话（磁盘多轮历史
		// 重新载入上下文，SDK 同时按会话头恢复 model）；无历史则新建。
		// continueRecent 的 cwd 必须与会话头 cwd 一致（现有会话头 cwd = agentDir）。
		const hasHistory =
			existsSync(sessionDir) &&
			readdirSync(sessionDir).some((file) => file.endsWith(".jsonl"));
		const sessionManager = hasHistory
			? SessionManager.continueRecent(this.agentDir, sessionDir)
			: SessionManager.create(this.agentDir, sessionDir);

		// cwd 设为 finclaw/（agentDir 的父目录）：AGENTS.md 的命令、临时文件路径
		// (.runtime/tmp/) 都相对 finclaw/ 目录。agentDir 仍指向 .pi，用于找 AGENTS.md 和 skills。
		const projectCwd = dirname(this.agentDir);

		// 稳定前缀仅在新会话创建时构建一次，经 appendSystemPrompt 追加到
		// .pi/AGENTS.md 基座之后（不传 systemPromptOverride，保留基座）。
		const stablePrefix = await this.buildStablePrefix(context);
		const resourceLoader = new DefaultResourceLoader({
			cwd: projectCwd,
			agentDir: this.agentDir,
			appendSystemPromptOverride: () => (stablePrefix ? [stablePrefix] : []),
		});
		await resourceLoader.reload();

		// 沙箱开关：默认启用（FINANCE_AGENT_SANDBOX="0" 关闭，回退到可读本地文件模式）。
		// 启用时用 noTools:"builtin" 禁用内置文件系统工具（read/ls/grep/find/edit/write），
		// 仅保留自定义后端 HTTP 业务工具，阻止 agent 查看本地开发源码。
		// 注意：tools 会被 SDK 当作 allowlist，只写白名单会过滤掉自定义工具，故用 noTools 而非 tools。
		const toolOptions = isAgentSandboxEnabled()
			? ({
					noTools: "builtin",
				} as const)
			: {
					excludeTools: ["bash"],
				};

		const result = await createAgentSession({
			cwd: projectCwd,
			agentDir: this.agentDir,
			...toolOptions,
			// M2: 注册自定义工具（customer_analyze + product_query + generate_plan + optimize_plan），
			// 让 Agent 在自由聊天时能直连 backend 获取实时数据
			customTools: createCustomTools(),
			sessionManager,
			resourceLoader,
		});

		session = result.session;
		this.sessions.set(sessionKey, session);

		// 将 FINANCE_API_URL 注入到 bash 工具的环境中
		// pi-agent 的 bash 工具会继承当前进程的环境变量
		process.env.FINANCE_API_URL = this.financeApiUrl;

		return session;
	}

	/**
	 * 列出所有会话摘要（从 .pi/sessions/ 目录读取）。
	 * 每个子目录对应一个 sessionKey(safeKey)，目录内按时间戳命名多个 jsonl 会话文件。
	 * 返回按 lastActivity 倒序。
	 */
	async listSessions(): Promise<SessionSummary[]> {
		const summaries: SessionSummary[] = [];
		if (!existsSync(this.sessionsDir)) {
			return summaries;
		}

		for (const safeKey of readdirSync(this.sessionsDir)) {
			const sessionDir = join(this.sessionsDir, safeKey);
			if (!statSync(sessionDir).isDirectory()) {
				continue;
			}
			// 按文件名排序（时间戳前缀 → 时间正序），保证 lastMessage 取到最新一条
			const files = readdirSync(sessionDir)
				.filter((file) => file.endsWith(".jsonl"))
				.sort();
			if (files.length === 0) {
				continue;
			}

			let messageCount = 0;
			let title = "";
			let lastModified = 0;
			let lastMessage = "";
			for (const file of files) {
				const filePath = join(sessionDir, file);
				const entries = parseSessionEntries(readFileSync(filePath, "utf-8"));
				// 消息数 = jsonl 文件总行数
				messageCount += entries.length;
				const mtime = statSync(filePath).mtimeMs;
				if (mtime > lastModified) {
					lastModified = mtime;
				}
				// 首条用户消息作为 title
				if (!title) {
					for (const entry of entries) {
						if (entry.type === "message" && entry.message.role === "user") {
							if ("content" in entry.message) {
								title = contentText(entry.message.content, "").trim();
							}
							break;
						}
					}
				}
				// 记录最近一条有效消息（文件按时间升序，后写入的覆盖前一条）
				for (const entry of entries) {
					if (entry.type === "message" && "content" in entry.message) {
						// 剥离 [会话上下文] 前缀后再展示
						const text = stripContextPrefix(contentText(entry.message.content, "")).trim();
						if (text) {
							lastMessage = text;
						}
					}
				}
			}

			summaries.push({
				sessionId: safeKey,
				title: title || safeKey,
				messageCount,
				lastActivity: new Date(lastModified).toISOString(),
				lastMessage,
			});
		}

		summaries.sort((a, b) => (a.lastActivity < b.lastActivity ? 1 : -1));
		return summaries;
	}

	/**
	 * 读取指定会话的完整消息列表（按"一问一答"聚合，工具步骤与工具 JSON 摘要并入回答）。
	 * @param sessionKey 会话 key
	 */
	async getSessionMessages(sessionKey: string): Promise<SessionMessage[]> {
		const dirKey = safeKey(sessionKey);
		const sessionDir = join(this.sessionsDir, dirKey);
		if (!existsSync(sessionDir)) {
			return [];
		}
		// 按文件名排序（时间戳前缀 → 时间正序），文件内条目顺序即为会话顺序
		const files = readdirSync(sessionDir)
			.filter((file) => file.endsWith(".jsonl"))
			.sort();

		const entries = files.flatMap((file) =>
			parseSessionEntries(readFileSync(join(sessionDir, file), "utf-8")),
		);
		return aggregateSessionEntries(entries);
	}

	/**
	 * 销毁所有会话（用于优雅关闭）
	 */
	disposeAll(): void {
		for (const session of this.sessions.values()) {
			try {
				session.dispose();
			} catch {
				// 忽略销毁错误
			}
		}
		this.sessions.clear();
	}

	/**
	 * 删除指定会话：先销毁内存会话（若有），再递归删除对应 jsonl 目录。
	 * 用于会话删除时级联清理孤儿对话历史。
	 * @returns 是否删除了磁盘目录
	 */
	deleteSession(sessionKey: string): boolean {
		const session = this.sessions.get(sessionKey);
		if (session) {
			try {
				session.dispose();
			} catch {
				// 忽略销毁错误
			}
			this.sessions.delete(sessionKey);
		}
		const sessionDir = join(this.sessionsDir, safeKey(sessionKey));
		if (existsSync(sessionDir)) {
			rmSync(sessionDir, { recursive: true, force: true });
			return true;
		}
		return false;
	}
}
