/**
 * 案例库（M0 · 优秀方案回灌）
 *
 * 存储已采纳的优秀方案，基于客户画像向量检索相似案例，
 * 用于方案生成时作为参考注入 LLM prompt。
 *
 * 设计：
 * - 内存 cosine 相似度 + JSON 文件持久化，零新增依赖
 * - Phase 1: 仅按客户画像检索，embedding 只基于画像字段
 * - 分层放宽兜底策略：全匹配 → 放宽 AUM → 放宽 segment → 仅风险
 * - GC: 经理超过 1000 条时淘汰 medium 质量最早入库的 20%
 */

import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import type { CustomerProfile, MarketingPlan, CaseSummary } from "./types.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ========== 类型定义 ==========

/** AUM 分桶 */
export type AumLevel = "L1" | "L2" | "L3" | "L4" | "L5";

/** 完整案例记录（存储用，含 embedding） */
export interface CaseRecord {
	caseId: string;
	planId: string;
	customerId: string;
	managerId: string;

	// 结构化检索键（硬过滤）
	segment: string;
	riskTolerance: string;
	lifeCycleStage: string;
	aumLevel: AumLevel;

	// 语义检索向量（仅基于客户画像）
	embedding: number[];

	// 注入 prompt 的摘要
	summary: {
		title: string;
		diagnosis: string;
		score: number;
		tags: string[];
		allocation: Record<string, { pct: number; products: string[] }>;
		products: Array<{ name: string; category: string; riskLevel: string; reason: string }>;
	};

	quality: "high" | "medium";
	createdAt: string;
}

/** 案例检索结果 */
export interface CaseSearchResult {
	cases: CaseSummary[];
	totalFound: number;
	strategy: "full" | "relaxed-aum" | "relaxed-segment" | "risk-only" | "none";
}

// ========== 常量配置 ==========

const MAX_CASES_PER_MANAGER = 1000;
const GC_RATIO = 0.2; // 超过上限时淘汰 20%
const TOP_K = 3; // 返回最相似的 top 3 案例
const SIMILARITY_THRESHOLD = 0.5; // 余弦相似度阈值，低于此不返回

// 从环境变量读取 DeepSeek 配置
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || "";
const DEEPSEEK_API_URL = (process.env.DEEPSEEK_API_URL || "https://api.deepseek.com").replace(/\/$/, "");
const EMBEDDING_MODEL = "text-embedding-bge-large-en-v1.5";

// ========== 核心工具函数 ==========

/** AUM 分桶：L1 < 10万, L2 10-50万, L3 50-200万, L4 200-1000万, L5 > 1000万 */
export function bucketAumLevel(aum: number): AumLevel {
	if (aum < 100_000) return "L1";
	if (aum < 500_000) return "L2";
	if (aum < 2_000_000) return "L3";
	if (aum < 10_000_000) return "L4";
	return "L5";
}

/** 余弦相似度计算 */
export function cosineSimilarity(a: number[], b: number[]): number {
	let dot = 0;
	let normA = 0;
	let normB = 0;
	const len = Math.min(a.length, b.length);
	for (let i = 0; i < len; i++) {
		dot += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}
	const product = Math.sqrt(normA) * Math.sqrt(normB);
	return product === 0 ? 0 : dot / product;
}

/** 将客户画像转为向量化文本（Phase 1: 只使用画像字段） */
function buildCustomerVectorText(customer: CustomerProfile): string {
	const parts: string[] = [];

	// 客群：决定推荐策略大方向
	if (customer.segment) {
		parts.push(`客群:${customer.segment}`);
	}

	// 风险等级：决定可投产品池和配置比例上限
	parts.push(`风险等级:${customer.riskTolerance}`);

	// 生命周期：影响资金用途和期限偏好
	if (customer.lifeCycleStage) {
		parts.push(`生命周期:${customer.lifeCycleStage}`);
	}

	// AUM 量级：影响起购门槛和产品可选范围
	parts.push(`AUM量级:${bucketAumLevel(customer.aum)}`);

	// 职业：补充客群判断
	if (customer.occupation) {
		parts.push(`职业:${customer.occupation}`);
	}

	// 偏好：客户明确表达的主观倾向
	if (customer.preferences && customer.preferences.length > 0) {
		parts.push(`偏好:${customer.preferences.join("、")}`);
	}

	return parts.join(" | ");
}

/**
 * 本地确定性 embedding：不对文本做语义编码，仅将字符哈希累加映射到固定维度。
 * 相同文本 → 相同向量；相近文本 → 部分维度重叠 → 相似度偏高。
 * 用于外部 embedding API 不可用时的降级（检索退化为"返回候选案例"而非空）。
 */
export function localEmbedding(text: string, dim = 64): number[] {
	const vec = new Array<number>(dim).fill(0);
	let seed = 2166136261;
	for (let i = 0; i < text.length; i++) {
		seed ^= text.charCodeAt(i);
		seed = Math.imul(seed, 16777619) >>> 0;
		vec[i % dim] += ((seed & 0xffff) / 65535) * 2 - 1;
	}
	return vec;
}

/** 调用 DeepSeek embedding API 获取文本向量；失败或未配置时回退到本地确定性向量 */
async function getEmbedding(text: string): Promise<number[]> {
	if (DEEPSEEK_API_KEY) {
		try {
			const response = await fetch(`${DEEPSEEK_API_URL}/embeddings`, {
				method: "POST",
				headers: {
					"Authorization": `Bearer ${DEEPSEEK_API_KEY}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					model: EMBEDDING_MODEL,
					input: text,
				}),
			});

			if (response.ok) {
				const data = await response.json();
				const emb = data?.data?.[0]?.embedding;
				if (Array.isArray(emb)) return emb;
			}
		} catch {
			// 网络/服务异常时静默降级到本地向量
		}
	}
	return localEmbedding(text);
}

// ========== CaseStore 类 ==========

/** 案例存储与检索 */
export class CaseStore {
	private cases: CaseRecord[] = [];
	private storagePath: string;
	private loaded = false;

	constructor(storageDir?: string) {
		// 默认存储路径: finclaw/.runtime/data/case-store.json
		// 与 backend store.mjs 的 runtime 目录对齐
		// pi-gateway/src/workflow/ → pi-gateway/src/ → pi-gateway/ → finclaw/
		const finclawDir = path.resolve(__dirname, "..", "..", "..");
		const defaultRuntime = process.env.FINANCE_RUNTIME_DIR || path.join(finclawDir, ".runtime", "data");
		this.storagePath = path.join(storageDir || defaultRuntime, "case-store.json");
		this.ensureDir();
	}

	private ensureDir(): void {
		const dir = path.dirname(this.storagePath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
	}

	/** 从 JSON 文件加载案例 */
	load(): void {
		if (!existsSync(this.storagePath)) {
			this.cases = [];
			this.loaded = true;
			return;
		}
		try {
			const content = readFileSync(this.storagePath, "utf-8");
			this.cases = JSON.parse(content);
		} catch {
			this.cases = [];
		}
		this.loaded = true;
	}

	/** 异步保存到 JSON 文件 */
	private save(): void {
		try {
			this.ensureDir();
			writeFileSync(this.storagePath, JSON.stringify(this.cases, null, 2) + "\n", "utf-8");
		} catch (err) {
			console.error("[case-store] 保存案例失败:", err);
		}
	}

	/** 垃圾回收：每个经理最多 1000 条，超过时淘汰 medium 最早的 */
	private gc(managerId: string): void {
		const managerCases = this.cases.filter(c => c.managerId === managerId);
		if (managerCases.length <= MAX_CASES_PER_MANAGER) {
			return;
		}

		// 需要淘汰的数量
		const toRemove = Math.ceil(managerCases.length * GC_RATIO);

		// 按质量分组：high 优先保留，medium 按创建时间升序（早的先淘汰）
		const high = managerCases.filter(c => c.quality === "high");
		let medium = managerCases
			.filter(c => c.quality === "medium")
			.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

		// 淘汰最旧的 toRemove 个
		medium = medium.slice(toRemove);

		// 重组列表（保留其他经理的所有案例）
		const other = this.cases.filter(c => c.managerId !== managerId);
		this.cases = [...other, ...high, ...medium];
	}

	/** 添加案例（幂等：同一 planId 覆盖） */
	async add(
		input: Omit<CaseRecord, "caseId" | "createdAt">
	): Promise<CaseRecord> {
		// 幂等去重：同一 planId 替换
		const existingIndex = this.cases.findIndex(
			c => c.planId === input.planId && c.managerId === input.managerId
		);

		const caseRecord: CaseRecord = {
			caseId: `case_${randomUUID().slice(0, 8)}`,
			createdAt: new Date().toISOString(),
			...input,
		};

		if (existingIndex >= 0) {
			// 保留原 caseId
			caseRecord.caseId = this.cases[existingIndex].caseId;
			this.cases[existingIndex] = caseRecord;
		} else {
			this.cases.push(caseRecord);
			this.gc(input.managerId);
		}

		this.save();
		return caseRecord;
	}

	/** 删除单个案例 */
	delete(caseId: string): boolean {
		const index = this.cases.findIndex(c => c.caseId === caseId);
		if (index < 0) return false;
		this.cases.splice(index, 1);
		this.save();
		return true;
	}

	/** 列出某经理所有案例（按创建时间倒序） */
	list(managerId: string): CaseRecord[] {
		return this.cases
			.filter(c => c.managerId === managerId)
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	}

	/** 搜索相似案例（分层放宽策略） */
	async search(
		target: CustomerProfile,
		managerId: string,
		topK: number = TOP_K
	): Promise<CaseSearchResult> {
		// 计算目标向量
		const targetText = buildCustomerVectorText(target);
		let targetEmbedding: number[];
		try {
			targetEmbedding = await getEmbedding(targetText);
		} catch (err) {
			console.warn("[case-store] 生成目标 embedding 失败，不返回案例:", err);
			return { cases: [], totalFound: 0, strategy: "none" };
		}

		const targetAum = bucketAumLevel(target.aum);
		const targetRisk = target.riskTolerance;
		const targetSegment = target.segment || "";
		const targetLifeCycle = target.lifeCycleStage || "";

		// 按 managerId 过滤（经理隔离）
		let candidates = this.cases.filter(c => c.managerId === managerId);

		// 分层预过滤
		let strategy: CaseSearchResult["strategy"] = "full";
		let filtered = candidates.filter(c =>
			c.riskTolerance === targetRisk &&
			c.segment === targetSegment &&
			c.aumLevel === targetAum
		);

		if (filtered.length < topK) {
			filtered = candidates.filter(c =>
				c.riskTolerance === targetRisk &&
				c.segment === targetSegment
			);
			strategy = "relaxed-aum";
		}

		if (filtered.length < topK) {
			filtered = candidates.filter(c =>
				c.riskTolerance === targetRisk
			);
			strategy = "relaxed-segment";
		}

		if (filtered.length < topK) {
			filtered = candidates;
			strategy = "risk-only";
		}

		if (filtered.length === 0) {
			return { cases: [], totalFound: 0, strategy: "none" };
		}

		// 余弦相似度排序
		const scored = filtered.map(c => ({
			case: c,
			similarity: cosineSimilarity(targetEmbedding, c.embedding),
		}));

		// 过滤掉相似度低于阈值的
		const filteredScored = scored.filter(s => s.similarity >= SIMILARITY_THRESHOLD);

		if (filteredScored.length === 0) {
			// 语义阈值过滤为空时，兜底返回结构化匹配的候选（避免案例库有数据却检索不到）
			const fallback = scored
				.slice()
				.sort((a, b) => b.similarity - a.similarity)
				.slice(0, topK);
			const fallbackSummaries: CaseSummary[] = fallback.map(t => ({
				caseId: t.case.caseId,
				title: t.case.summary.title,
				diagnosis: t.case.summary.diagnosis,
				score: t.case.summary.score,
				tags: t.case.summary.tags,
				allocation: t.case.summary.allocation,
				products: t.case.summary.products,
			}));
			return { cases: fallbackSummaries, totalFound: fallback.length, strategy };
		}

		// 按相似度降序，取 topK
		filteredScored.sort((a, b) => b.similarity - a.similarity);
		const top = filteredScored.slice(0, topK);

		// 转为摘要（不含 embedding，用于注入 prompt）
		const summaries: CaseSummary[] = top.map(t => ({
			caseId: t.case.caseId,
			title: t.case.summary.title,
			diagnosis: t.case.summary.diagnosis,
			score: t.case.summary.score,
			tags: t.case.summary.tags,
			allocation: t.case.summary.allocation,
			products: t.case.summary.products,
		}));

		return {
			cases: summaries,
			totalFound: filteredScored.length,
			strategy,
		};
	}

	/** 从已采纳方案构建并添加案例 */
	async addFromPlan(
		plan: MarketingPlan,
		customer: CustomerProfile,
		managerId: string,
	): Promise<CaseRecord> {
		const quality: CaseRecord["quality"] = plan.score >= 9 ? "high" : "medium";

		// 生成向量
		const vectorText = buildCustomerVectorText(customer);
		const embedding = await getEmbedding(vectorText);

		return this.add({
			planId: plan.planId,
			customerId: customer.customerId,
			managerId,
			segment: customer.segment || "",
			riskTolerance: customer.riskTolerance,
			lifeCycleStage: customer.lifeCycleStage || "",
			aumLevel: bucketAumLevel(customer.aum),
			embedding,
			summary: {
				title: plan.title,
				diagnosis: plan.diagnosis,
				score: plan.score,
				tags: plan.tags,
				allocation: plan.allocation,
				products: plan.products.map(p => ({
					name: p.name,
					category: p.category,
					riskLevel: p.riskLevel,
					reason: p.reason,
				})),
			},
			quality,
		});
	}
}

// ========== 单例导出（生产环境使用） ==========

let instance: CaseStore | null = null;

export function getCaseStore(): CaseStore {
	if (!instance) {
		instance = new CaseStore();
		instance.load();
	}
	return instance;
}
