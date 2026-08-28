/**
 * Workflow 模块聚合导出 + 生产环境工厂
 *
 * createWorkflowDeps 装配真实 backend-client + 真实 llm-leaf + 真实 retry,
 * 供 server.ts 调用。单测中通过直接构造 WorkflowDeps 注入 mock。
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createBackendClient } from "./backend-client.ts";
import { createLlmLeaf } from "./llm-leaf.ts";
import { buildRetryInstructions } from "./retry-context.ts";
import type { WorkflowDeps } from "./types.ts";

export { runGeneratePlan, runOptimizePlan } from "./orchestrator.ts";
export { buildRetryInstructions } from "./retry-context.ts";
export { createBackendClient } from "./backend-client.ts";
export { createLlmLeaf } from "./llm-leaf.ts";
export type {
	WorkflowDeps,
	WorkflowRequest,
	WorkflowResult,
	WorkflowAction,
	WorkflowContext,
	MarketingPlan,
} from "./types.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * 计算 pi 根目录(.pi/)默认路径。
 *
 * pi-gateway/src/workflow/index.ts → 上溯 3 级到 finclaw/,再进入 .pi/。
 * 允许通过 env PI_CODING_AGENT_DIR 覆盖(与 server.ts 的 PI_AGENT_DIR 一致)。
 */
function resolvePiAgentDir(): string {
	const envDir = process.env.PI_CODING_AGENT_DIR;
	if (envDir) return envDir;
	// pi-gateway/src/workflow/ → pi-gateway/src/ → pi-gateway/ → finclaw/
	const finclawDir = join(__dirname, "..", "..", "..");
	return join(finclawDir, ".pi");
}

/**
 * 计算叶子人设文件路径:.pi/agents/plan-generator/AGENTS.md
 */
function resolveLeafPromptFile(piAgentDir: string): string {
	return join(piAgentDir, "agents", "plan-generator", "AGENTS.md");
}

/**
 * 生产环境装配:真实 backend-client + 真实 llm-leaf + 真实 retry。
 * server.ts 调用此工厂获取 WorkflowDeps。
 */
export function createWorkflowDeps(): WorkflowDeps {
	const piAgentDir = resolvePiAgentDir();
	const leafPromptFile = resolveLeafPromptFile(piAgentDir);
	return {
		backend: createBackendClient(),
		llm: createLlmLeaf(piAgentDir, leafPromptFile),
		retry: { buildRetryInstructions },
	};
}
