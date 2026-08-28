import { describe, it, expect, vi, afterEach } from "vitest";
import type { Mock } from "vitest";
import { createBackendClient } from "../backend-client.ts";

// ========== 测试数据与 mock 基建 ==========

const profile = {
	customerId: "CUST_001",
	name: "张明远",
	riskTolerance: "C3",
	aum: 6800000,
};

function jsonResponse(payload: unknown) {
	return {
		ok: true,
		status: 200,
		json: async () => payload,
		text: async () => "",
	};
}

/** mock 全局 fetch:按 URL 路由返回不同响应,未匹配 URL 抛错 */
function stubFetchByUrl(
	handler: (url: string) => unknown | Promise<unknown>,
): Mock {
	const fetchMock = vi.fn(async (input: string | URL | Request) => {
		const url = String(input);
		return jsonResponse(await handler(url));
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

// ========== fetchContext scope 分流测试 ==========

describe("createBackendClient().fetchContext scope 分流", () => {
	it("customer scope:仅发起 1 个 profile 请求", async () => {
		const fetchMock = stubFetchByUrl((url) => {
			if (url.includes("/api/customers/CUST_001/profile")) return profile;
			throw new Error(`unexpected fetch: ${url}`);
		});

		const ctx = await createBackendClient().fetchContext(
			"CUST_001",
			"MGR_001",
			"customer",
		);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(String(fetchMock.mock.calls[0][0])).toContain(
			"/api/customers/CUST_001/profile",
		);
		expect(ctx.customer.customerId).toBe("CUST_001");
		expect(ctx.products).toEqual([]);
		expect(ctx.personalKnowledge).toBe("");
		expect(ctx.marketBrief).toBe("");
	});

	it("plan scope:发起 5 个请求,含 market/brief 与 tasks(注入 strategies),不含 products/strategies 接口", async () => {
		const fetchMock = stubFetchByUrl((url) => {
			if (url.includes("/api/customers/CUST_001/profile")) return profile;
			if (url.includes("/api/products/eligible")) return [];
			if (url.includes("/api/knowledge")) return { content: "偏好稳健" };
			if (url.includes("/api/market/brief")) return { content: "市场整体平稳" };
			if (url.includes("/api/customers/CUST_001/tasks")) {
				return [
					{
						taskId: "T1",
						customerId: "CUST_001",
						strategyType: "maturity",
						strategyName: "到期资金承接",
						category: "资产事件",
						priority: 100,
						triggerCondition: "三年定期到期",
						status: "pending",
						source: "rule",
						createdAt: "2026-08-18T01:35:11.818Z",
					},
				];
			}
			throw new Error(`unexpected fetch: ${url}`);
		});

		const ctx = await createBackendClient().fetchContext(
			"CUST_001",
			"MGR_001",
			"plan",
		);

		expect(fetchMock).toHaveBeenCalledTimes(5);
		const urls = fetchMock.mock.calls.map((c) => String(c[0]));
		expect(urls.some((u) => u.includes("/api/market/brief"))).toBe(true);
		expect(urls.some((u) => u.includes("/api/customers/CUST_001/tasks"))).toBe(true);
		expect(urls.some((u) => u.includes("/api/products/strategies"))).toBe(false);
		expect(ctx.customer.customerId).toBe("CUST_001");
		expect(ctx.personalKnowledge).toBe("偏好稳健");
		expect(ctx.marketBrief).toBe("市场整体平稳");
		expect(ctx.strategies).toHaveLength(1);
		expect(ctx.strategies?.[0].strategyName).toBe("到期资金承接");
		expect(ctx.strategies?.[0].priority).toBe(100);
	});

	it("缺省 scope 走 plan,market brief 拉取失败降级为空字符串", async () => {
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url = String(input);
			if (url.includes("/api/market/brief")) {
				throw new Error("network down");
			}
			return jsonResponse(
				url.includes("/api/customers/CUST_001/profile")
					? profile
					: url.includes("/api/products/eligible")
						? []
						: url.includes("/api/customers/CUST_001/tasks")
							? []
							: "偏好稳健",
			);
		});
		vi.stubGlobal("fetch", fetchMock);

		const ctx = await createBackendClient().fetchContext("CUST_001", "MGR_001");

		expect(fetchMock).toHaveBeenCalledTimes(5);
		expect(ctx.marketBrief).toBe("");
		// 其余四路不受 market brief 失败影响(knowledge 为字符串直取)
		expect(ctx.personalKnowledge).toBe("偏好稳健");
		expect(ctx.strategies).toEqual([]);
	});
});
