/**
 * 洞察编排模块聚合导出
 *
 * 已按职责拆分为独立文件（insight-batch / self-evolve / prompts / llm-json /
 * backend-client），本文件仅保留对外导出兼容，server.ts 的导入保持不变。
 */

export {
	runBatchInsight,
	createInsightLlm,
	createInsightDeps,
} from "./insight-batch.ts";
export type {
	InsightRequest,
	InsightItem,
	InsightResult,
	InsightLlm,
	InsightDeps,
} from "./insight-batch.ts";

export {
	runExtractInsightFromPlan,
	runSuggestKnowledge,
} from "./self-evolve.ts";
export type {
	ExtractInsightRequest,
	ExtractedInsight,
	KnowledgeSuggestRequest,
	KnowledgeSuggestion,
} from "./self-evolve.ts";

export { runLlmJson } from "./llm-json.ts";