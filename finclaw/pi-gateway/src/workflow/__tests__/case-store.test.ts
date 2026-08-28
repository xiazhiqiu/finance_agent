import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CustomerProfile, MarketingPlan } from "../types.ts";

// 延迟加载:需先 stub DEEPSEEK_API_KEY 再导入(模块顶层读取 env)
type CaseStoreModule = typeof import("../case-store.ts");
let CaseStore: CaseStoreModule["CaseStore"];
let bucketAumLevel: CaseStoreModule["bucketAumLevel"];
let cosineSimilarity: CaseStoreModule["cosineSimilarity"];

/** 确定性伪 embedding:按风险等级映射到独立维度。
 * 相同风险 → 相同向量(相似度 1);不同风险 → 正交向量(相似度 0),可确定性验证阈值过滤。 */
function mockEmbedding(input: string): number[] {
	const vec = new Array(8).fill(0);
	const riskMatch = input.match(/风险等级:R(\d)/);
	const riskIdx = riskMatch ? Number(riskMatch[1]) % 8 : 0;
	vec[riskIdx] = 1;
	return vec;
}

beforeAll(async () => {
	vi.stubEnv("DEEPSEEK_API_KEY", "test-key");
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_url: string, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body)) as { input: string };
			return {
				ok: true,
				json: async () => ({ data: [{ embedding: mockEmbedding(body.input) }] }),
			} as unknown as Response;
		}),
	);
	const mod = await import("../case-store.ts");
	CaseStore = mod.CaseStore;
	bucketAumLevel = mod.bucketAumLevel;
	cosineSimilarity = mod.cosineSimilarity;
});

afterAll(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

// ========== 测试数据构造 ==========

function makeCustomer(overrides: Partial<CustomerProfile> = {}): CustomerProfile {
	return {
		customerId: "CUST_001",
		name: "张明远",
		riskTolerance: "R2",
		aum: 800000,
		...overrides,
	};
}

function makePlan(planId: string, title = `方案${planId}`): MarketingPlan {
	return {
		planId,
		customerId: "CUST_001",
		title,
		score: 8,
		tags: ["稳健"],
		diagnosis: "退休阶段，偏好固收",
		allocation: { 固收理财: { pct: 50, products: ["产品A"] } },
		products: [{ productId: "P001", name: "产品A", category: "固收理财", riskLevel: "R2", reason: "稳健增值" }],
		scripts: { wecom: "", phone: [] },
		markdown: "",
	};
}

function makeStore() {
	const dir = mkdtempSync(path.join(tmpdir(), "case-store-test-"));
	const store = new CaseStore(dir);
	store.load();
	return { store, dir };
}

// ========== 单元测试 ==========

describe("bucketAumLevel", () => {
	it("边界分桶正确", () => {
		expect(bucketAumLevel(0)).toBe("L1");
		expect(bucketAumLevel(99_999)).toBe("L1");
		expect(bucketAumLevel(100_000)).toBe("L2");
		expect(bucketAumLevel(500_000)).toBe("L3");
		expect(bucketAumLevel(2_000_000)).toBe("L4");
		expect(bucketAumLevel(10_000_000)).toBe("L5");
	});
});

describe("cosineSimilarity", () => {
	it("相同向量 → 1,正交向量 → 0", () => {
		expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
		expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
	});
	it("零向量 → 0", () => {
		expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
	});
});

describe("CaseStore.add/list/delete", () => {
	it("入库幂等:同一 planId 覆盖且保留原 caseId", async () => {
		const { store, dir } = makeStore();
		try {
			const c1 = await store.addFromPlan(makePlan("plan-A"), makeCustomer(), "m1");
			const c2 = await store.addFromPlan(
				{ ...makePlan("plan-A"), score: 10, title: "更新后" },
				makeCustomer(),
				"m1",
			);
			expect(c1.caseId).toBe(c2.caseId);
			const list = store.list("m1");
			expect(list).toHaveLength(1);
			expect(list[0].summary.title).toBe("更新后");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("经理隔离:list/search 只返回本经理案例", async () => {
		const { store, dir } = makeStore();
		try {
			await store.addFromPlan(makePlan("plan-A"), makeCustomer(), "m1");
			await store.addFromPlan(makePlan("plan-B"), makeCustomer(), "m2");
			expect(store.list("m1")).toHaveLength(1);
			expect(store.list("m2")).toHaveLength(1);

			const result = await store.search(makeCustomer(), "m1", 3);
			expect(result.totalFound).toBe(1);
			expect(result.cases[0].title).toBe("方案plan-A");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("删除单个案例", async () => {
		const { store, dir } = makeStore();
		try {
			const c = await store.addFromPlan(makePlan("plan-A"), makeCustomer(), "m1");
			expect(store.delete(c.caseId)).toBe(true);
			expect(store.delete(c.caseId)).toBe(false);
			expect(store.list("m1")).toHaveLength(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("CaseStore.search 分层策略", () => {
	it("全匹配 → strategy full,返回 Top-3", async () => {
		const { store, dir } = makeStore();
		try {
			const customer = makeCustomer({ segment: "退休", lifeCycleStage: "消耗" });
			for (let i = 0; i < 5; i++) {
				await store.addFromPlan(makePlan(`plan-${i}`), customer, "m1");
			}
			const result = await store.search(customer, "m1", 3);
			expect(result.strategy).toBe("full");
			expect(result.cases).toHaveLength(3);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("全匹配不足 → 放宽 AUM 约束", async () => {
		const { store, dir } = makeStore();
		try {
			const target = makeCustomer({ segment: "退休", lifeCycleStage: "消耗", aum: 800_000 });
			// 1 个全匹配 + 3 个 risk/segment 匹配但 aum 不同
			await store.addFromPlan(makePlan("full"), target, "m1");
			await store.addFromPlan(
				makePlan("relaxed-1"),
				makeCustomer({ segment: "退休", lifeCycleStage: "消耗", aum: 8_000_000 }),
				"m1",
			);
			await store.addFromPlan(
				makePlan("relaxed-2"),
				makeCustomer({ segment: "退休", lifeCycleStage: "积累", aum: 40_000 }),
				"m1",
			);
			const result = await store.search(target, "m1", 3);
			expect(result.strategy).toBe("relaxed-aum");
			expect(result.cases).toHaveLength(3);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("无 risk/segment/aum 匹配 → 落入 risk-only 兜底层,语义阈值为空时兜底返回候选", async () => {
		const { store, dir } = makeStore();
		try {
			await store.addFromPlan(
				makePlan("plan-A"),
				makeCustomer({ riskTolerance: "R5", segment: "企业主" }),
				"m1",
			);
			const result = await store.search(
				makeCustomer({ riskTolerance: "R2", segment: "退休" }),
				"m1",
				3,
			);
			// 兜底层假设所有候选;相似度低于阈值被过滤后,兜底返回结构化匹配候选而非空
			expect(result.strategy).toBe("risk-only");
			expect(result.cases).toHaveLength(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("embedding API 失败时静默降级为空(不抛出)", async () => {
		const { store, dir } = makeStore();
		try {
			const originalFetch = globalThis.fetch;
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => ({ ok: false, status: 500, text: async () => "boom" })),
			);
			try {
				const result = await store.search(makeCustomer(), "m1", 3);
				expect(result.strategy).toBe("none");
				expect(result.cases).toHaveLength(0);
			} finally {
				vi.stubGlobal("fetch", originalFetch);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("CaseStore GC", () => {
	it("超过 1000 条时触发 GC:总量不超上限、high 保留、最早 medium 被淘汰", async () => {
		const { store, dir } = makeStore();
		try {
			const customer = makeCustomer();
			// 先加 1 个 high(score=10),再加 1001 个 medium
			await store.addFromPlan({ ...makePlan("high"), score: 10 }, customer, "m1");
			for (let i = 0; i < 1001; i++) {
				await store.addFromPlan(makePlan(`plan-${i}`), customer, "m1");
			}
			const list = store.list("m1");
			// GC 超出上限时淘汰 20%(总量振荡在 800 附近),不会超过上限
			expect(list.length).toBeLessThanOrEqual(1000);
			// high 案例必然保留
			expect(list.some((c) => c.planId === "high")).toBe(true);
			// 最早入库的 medium(plan-0)已被淘汰
			expect(list.some((c) => c.planId === "plan-0")).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
