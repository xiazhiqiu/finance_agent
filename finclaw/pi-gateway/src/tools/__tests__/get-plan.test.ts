import { describe, it, expect, vi, afterEach } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createGetPlanTool } from "../customer-analyze.ts";

// 工具 ctx 参数为 ExtensionContext，运行时仅读取 managerId 字段
const ctx = { managerId: "MGR_001" } as unknown as ExtensionContext;

const snapshotRecord = {
	planId: "plan-CUST_001-A",
	customerId: "CUST_001",
	managerId: "MGR_001",
	title: "稳健配置方案",
	score: 90,
	tags: ["稳健", "防御型"],
	diagnosis: "客户为 C3 稳健型，偏好一年内稳健产品。",
	allocation: { "理财产品": { pct: 60, products: ["固收理财"] }, "存款类": { pct: 40, products: ["大额存单"] } },
	products: [{ productId: "P001", name: "固收理财", category: "理财产品", riskLevel: "R2", reason: "稳健匹配" }],
	scripts: { wecom: "您好，为您准备了稳健方案。", phone: ["电话话术一"] },
	markdown: "## 方案",
};

interface ToolResult {
	details: { success: boolean; error?: string; plan?: unknown };
	content: Array<{ type: string; text?: string }>;
}

function mockFetch(payload: unknown) {
	vi.stubGlobal(
		"fetch",
		vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => payload,
			text: async () => "",
		}),
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("get_plan 工具", () => {
	it("命中快照：返回格式化详情，details 携带完整方案", async () => {
		mockFetch({ data: [snapshotRecord] });
		const out = (await createGetPlanTool().execute(
			"call-1",
			{ plan_id: "plan-CUST_001-A" },
			undefined,
			undefined,
			ctx,
		)) as unknown as ToolResult;
		expect(out.details.success).toBe(true);
		expect(out.content[0].text).toContain("稳健配置方案");
		expect(out.content[0].text).toContain("固收理财");
		expect(out.content[0].text).toContain("企业微信话术");
		expect(out.content[0].text).not.toContain("```json");
		expect(out.details.plan).toEqual(snapshotRecord);
	});

	it("未命中：返回错误提示", async () => {
		mockFetch({ data: [] });
		const out = (await createGetPlanTool().execute(
			"call-1",
			{ plan_id: "plan-NOT-EXIST" },
			undefined,
			undefined,
			ctx,
		)) as unknown as ToolResult;
		expect(out.details.success).toBe(false);
		expect(out.content[0].text).toContain("未找到方案");
	});

	it("backend 请求失败：返回错误信息", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: false,
				status: 500,
				json: async () => ({}),
				text: async () => "boom",
			}),
		);
		const out = (await createGetPlanTool().execute(
			"call-1",
			{ plan_id: "plan-CUST_001-A" },
			undefined,
			undefined,
			ctx,
		)) as unknown as ToolResult;
		expect(out.details.success).toBe(false);
		expect(out.content[0].text).toContain("获取方案详情失败");
	});
});
