import { describe, it, expect } from "vitest";
import type { AgentSessionManager } from "../../agent-session.ts";
import { runPlanInSession, runBatchPlanInSessions } from "../plan-in-session.ts";

/** 构造一个 mock 会话管理器：按 sessionKey 注入成功/失败行为，并统计最大并发 */
function makeMockManager(opts: { failKeys?: Set<string>; delayMs?: number } = {}) {
	const { failKeys = new Set(), delayMs = 10 } = opts;
	const concurrency = { max: 0, current: 0 };
	const manager = {
		runPrompt: async (
			sessionKey: string,
			_message: string,
			callbacks: {
				onToolResult?: (toolName: string, result: unknown) => void;
				onFinal?: (text: string) => void;
			},
		): Promise<void> => {
			concurrency.current++;
			concurrency.max = Math.max(concurrency.max, concurrency.current);
			await new Promise((resolve) => setTimeout(resolve, delayMs));
			concurrency.current--;
			if (failKeys.has(sessionKey)) {
				throw new Error(`会话 ${sessionKey} 内部异常`);
			}
			callbacks.onToolResult?.("generate_plan", {
				details: { result: { plans: [{ planId: `plan-${sessionKey}` }], complianceReport: { passed: true } } },
			});
			callbacks.onFinal?.("已生成方案");
		},
	} as unknown as AgentSessionManager;
	return { manager, concurrency };
}

const base = { customerId: "CUST_001", managerId: "MGR_001" };

describe("runPlanInSession", () => {
	it("成功时捕获 generate_plan 的 details.result", async () => {
		const { manager } = makeMockManager();
		const out = await runPlanInSession(manager, {
			sessionKey: "k1",
			...base,
			instruction: "请为该客户生成一套营销方案",
		});
		expect(out.error).toBeUndefined();
		expect(out.result?.plans?.[0]?.planId).toBe("plan-k1");
		expect(out.finalText).toBe("已生成方案");
	});

	it("runPrompt 抛出异常时转为 error，不向上抛", async () => {
		const { manager } = makeMockManager({ failKeys: new Set(["k1"]) });
		const out = await runPlanInSession(manager, {
			sessionKey: "k1",
			...base,
			instruction: "请为该客户生成一套营销方案",
		});
		expect(out.result).toBeUndefined();
		expect(out.error).toContain("内部异常");
	});

	it("未捕获到任何工具结果时报错提示", async () => {
		const manager = {
			runPrompt: async (
				_sessionKey: string,
				_message: string,
				callbacks: { onFinal?: (text: string) => void },
			): Promise<void> => {
				// 不触发任何 generate_plan 工具结果
				callbacks.onFinal?.("不带方案的回复");
			},
		} as unknown as AgentSessionManager;
		const out = await runPlanInSession(manager, {
			sessionKey: "k1",
			...base,
			instruction: "请为该客户生成一套营销方案",
		});
		expect(out.result).toBeUndefined();
		expect(out.error).toContain("未捕获到方案生成工具结果");
	});
});

describe("runBatchPlanInSessions", () => {
	it("受控并发：瞬时并发不超过 concurrency，返回与原数组同序", async () => {
		const { manager, concurrency } = makeMockManager({ delayMs: 20 });
		const items = [1, 2, 3, 4, 5, 6, 7].map((n) => ({
			sessionKey: `k${n}`,
			...base,
			instruction: "请为该客户生成一套营销方案",
		}));
		const outputs = await runBatchPlanInSessions(manager, items, 3);
		expect(concurrency.max).toBeLessThanOrEqual(3);
		expect(outputs).toHaveLength(7);
		// 同序返回
		expect(outputs.map((o) => o.sessionKey)).toEqual(items.map((i) => i.sessionKey));
		expect(outputs.every((o) => o.result?.plans?.[0])).toBe(true);
	});

	it("单会话失败隔离：不影响其它会话成功", async () => {
		const { manager } = makeMockManager({ failKeys: new Set(["k2", "k5"]) });
		const items = [1, 2, 3, 4, 5].map((n) => ({
			sessionKey: `k${n}`,
			...base,
			instruction: "请为该客户生成一套营销方案",
		}));
		const outputs = await runBatchPlanInSessions(manager, items, 2);
		const errors = outputs.filter((o) => o.error).map((o) => o.sessionKey).sort();
		const successes = outputs.filter((o) => o.result).map((o) => o.sessionKey).sort();
		expect(errors).toEqual(["k2", "k5"]);
		expect(successes).toEqual(["k1", "k3", "k4"]);
	});
});