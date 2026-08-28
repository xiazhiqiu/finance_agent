/**
 * 批量洞察编排（M2 · 能力原子化）
 *
 * 在规则层（strategies.mjs）生成的确定性任务基础上，
 * 用 LLM 为每个客户生成深度洞察（营销机会、资产配置建议、风险预警），
 * 并写入 backend insights 存储，供前端"待确认洞察"消费。
 *
 * 纯函数式编排，依赖注入，可单测。
 */

import { readFileSync, existsSync } from "node:fs";
import type {
	BackendClient,
	WorkflowContext,
} from "./types.ts";
import { buildInsightPrompt } from "./prompts.ts";
import { runLlmJsonOnce } from "./llm-json.ts";
import {
	createBackendClient,
	backendWriteInsight,
	backendReadRuleTasks,
} from "./backend-client.ts";

// ========== 洞察编排类型 ==========

export interface InsightRequest {
	customerIds: string[];
	managerId: string;
}

export interface InsightItem {
	customerId: string;
	content: string;
	tags: string[];
	source: "llm";
}

export interface InsightResult {
	total: number;
	succeeded: number;
	failed: number;
	failures: Array<{ customerId: string; error: string }>;
	insights: InsightItem[];
}

/**
 * LLM 洞察生成接口（依赖注入，单测可 mock）。
 * 接收客户上下文 + 规则任务，返回结构化洞察。
 */
export interface InsightLlm {
	generateInsight(
		context: WorkflowContext,
		ruleTasks: Array<{ strategyType: string; strategyName: string; triggerCondition: string }>,
	): Promise<{ content: string; tags: string[] }>;
}

export interface InsightDeps {
	backend: BackendClient;
	llm: InsightLlm;
	/** 写洞察到 backend（POST /api/insights），单测可 mock */
	writeInsight(
		customerId: string,
		insight: { content: string; tags: string[]; source: "llm" },
		managerId: string,
	): Promise<unknown>;
	/** 读取客户规则任务（GET /api/customers/:id/tasks），单测可 mock */
	readRuleTasks(customerId: string, managerId: string): Promise<
		Array<{ strategyType: string; strategyName: string; triggerCondition: string }>
	>;
}

// ========== 生产环境 LLM 实现（复用 llm-json 的一次性调用原子） ==========

/**
 * 创建洞察 LLM。
 * 复用 llm-json 的一次性 LLM JSON 调用原子，使用独立人设文件
 * （insight-generator/AGENTS.md），若该文件不存在则用内联 prompt。
 */
export function createInsightLlm(
	piAgentDir: string,
	leafPromptFile?: string,
): InsightLlm {
	const agentDir = piAgentDir;
	const leafSystemPrompt =
		leafPromptFile && existsSync(leafPromptFile)
			? readFileSync(leafPromptFile, "utf-8")
			: "你是银行客户经理的洞察分析助手。只输出 JSON，不加解释或代码围栏。";

	return {
		async generateInsight(context, ruleTasks) {
			const { parsed, rawText } = await runLlmJsonOnce(
				agentDir,
				leafSystemPrompt,
				buildInsightPrompt(context, ruleTasks),
				"insight",
			);

			// 宽松解析 JSON
			if (
				parsed &&
				typeof parsed === "object" &&
				typeof (parsed as { content?: unknown }).content === "string"
			) {
				const obj = parsed as { content: string; tags?: unknown };
				return {
					content: obj.content,
					tags: Array.isArray(obj.tags)
						? obj.tags.filter((t): t is string => typeof t === "string")
						: ["LLM洞察"],
				};
			}

			throw new Error(`LLM 洞察输出解析失败，原始文本前 200 字符: ${rawText.slice(0, 200)}`);
		},
	};
}

/**
 * 生产环境依赖工厂。
 */
export function createInsightDeps(
	piAgentDir: string,
	leafPromptFile?: string,
): InsightDeps {
	return {
		backend: {
			// 复用 backend-client 的 fetchContext,洞察只消费客户画像(customer scope)
			async fetchContext(customerId: string, managerId: string) {
				return createBackendClient().fetchContext(customerId, managerId, "customer");
			},
			// audit 不用于洞察编排，提供空实现
			async audit() {
				throw new Error("audit not used in insight orchestrator");
			},
		},
		llm: createInsightLlm(piAgentDir, leafPromptFile),
		writeInsight: backendWriteInsight,
		readRuleTasks: backendReadRuleTasks,
	};
}

// ========== 核心编排函数 ==========

/**
 * 批量洞察生成编排。
 *
 * 对每个客户：
 * 1. 取数（客户画像 + 产品 + 策略 + 个人知识库）
 * 2. 读取规则层已生成的任务
 * 3. 调用 LLM 生成深度洞察
 * 4. 写入 backend insights 存储
 *
 * 错误隔离：单个客户失败不影响其他客户。
 */
export async function runBatchInsight(
	req: InsightRequest,
	deps: InsightDeps,
): Promise<InsightResult> {
	const result: InsightResult = {
		total: req.customerIds.length,
		succeeded: 0,
		failed: 0,
		failures: [],
		insights: [],
	};

	for (const customerId of req.customerIds) {
		try {
			// 1. 取数
			const context = await deps.backend.fetchContext(customerId, req.managerId);

			// 2. 读取规则任务
			const ruleTasks = await deps.readRuleTasks(customerId, req.managerId);

			// 3. LLM 生成洞察
			const insight = await deps.llm.generateInsight(context, ruleTasks);

			// 4. 写入 backend
			await deps.writeInsight(
				customerId,
				{
					content: insight.content,
					tags: insight.tags,
					source: "llm",
				},
				req.managerId,
			);

			result.insights.push({
				customerId,
				content: insight.content,
				tags: insight.tags,
				source: "llm",
			});
			result.succeeded++;
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			result.failed++;
			result.failures.push({ customerId, error: msg });
			console.error(`[insight-orchestrator] 客户 ${customerId} 洞察生成失败:`, msg);
		}
	}

	return result;
}