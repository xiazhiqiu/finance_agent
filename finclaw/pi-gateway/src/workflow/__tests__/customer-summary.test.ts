import { describe, it, expect, vi } from "vitest";
import { buildSummaryPrompt, runRefreshCustomerSummary } from "../customer-summary.ts";

// ========== buildSummaryPrompt ==========

describe("buildSummaryPrompt", () => {
	it("existing 存在时包含已有摘要段落（原样放入）", () => {
		const prompt = buildSummaryPrompt("客户偏好稳健理财", [
			{ role: "user", content: "最近有什么推荐?" },
		]);
		expect(prompt).toContain("## 已有摘要");
		expect(prompt).toContain("客户偏好稳健理财");
		expect(prompt).toContain("## 最近对话");
		expect(prompt).toContain("user: 最近有什么推荐?");
		expect(prompt).toContain("## 输出要求");
	});

	it("每条 content 截断 400 字符", () => {
		const long = "长".repeat(500);
		const prompt = buildSummaryPrompt(undefined, [{ role: "user", content: long }]);
		expect(prompt).toContain("长".repeat(400));
		expect(prompt).not.toContain("长".repeat(401));
	});

	it("只保留最近 12 条（15 条时丢弃最早 3 条）", () => {
		const messages = Array.from({ length: 15 }, (_, i) => ({
			role: "user",
			content: `消息-${String(i).padStart(2, "0")}`,
		}));
		const prompt = buildSummaryPrompt(undefined, messages);
		expect(prompt).not.toContain("消息-00");
		expect(prompt).not.toContain("消息-01");
		expect(prompt).not.toContain("消息-02");
		expect(prompt).toContain("消息-03");
		expect(prompt).toContain("消息-14");
	});
});

// ========== runRefreshCustomerSummary ==========

describe("runRefreshCustomerSummary", () => {
	it("LLM 输出合法时 PUT 收敛后的五字段摘要", async () => {
		const putSummary = vi.fn().mockResolvedValue(undefined);
		const runLlmOnce = vi.fn().mockResolvedValue({
			parsed: {
				preferences: ["稳健理财", 123],
				adoptedPlans: ["定投组合"],
				concerns: [null, "市场波动"],
				opportunities: "不是数组",
				raw: "客户关注稳健，已采纳定投组合。",
			},
			rawText: "{}",
		});
		const fetchExisting = vi.fn().mockResolvedValue("旧摘要");

		await runRefreshCustomerSummary(
			{ customerId: "CUST_001", managerId: "MGR_001", messages: [{ role: "user", content: "你好" }] },
			"/tmp/agent",
			{ runLlmOnce, putSummary, fetchExisting },
		);

		expect(fetchExisting).toHaveBeenCalledWith("CUST_001", "MGR_001");
		expect(runLlmOnce).toHaveBeenCalledWith(
			"/tmp/agent",
			"你是银行客户经理的会话摘要助手。只输出 JSON，不加解释或代码围栏。",
			expect.stringContaining("旧摘要"),
			"summary",
		);
		expect(putSummary).toHaveBeenCalledWith(
			"CUST_001",
			{
				preferences: ["稳健理财"],
				adoptedPlans: ["定投组合"],
				concerns: ["市场波动"],
				opportunities: [],
				raw: "客户关注稳健，已采纳定投组合。",
			},
			"MGR_001",
		);
	});

	it("parsed 非 object 时兜底：raw 为最近 6 条拼接（每条截 200 字），数组为空，仍执行 PUT", async () => {
		const putSummary = vi.fn().mockResolvedValue(undefined);
		const runLlmOnce = vi.fn().mockResolvedValue({ parsed: null, rawText: "" });
		const fetchExisting = vi.fn().mockResolvedValue(undefined);

		const messages = [
			...Array.from({ length: 7 }, (_, i) => ({ role: "user", content: `内容${i}` })),
			{ role: "user", content: "备".repeat(300) },
		];
		await runRefreshCustomerSummary(
			{ customerId: "CUST_002", managerId: "MGR_001", messages },
			"/tmp/agent",
			{ runLlmOnce, putSummary, fetchExisting },
		);

		expect(putSummary).toHaveBeenCalledTimes(1);
		const body = putSummary.mock.calls[0][1];
		// 最近 6 条：内容2~内容6 + 长消息（截 200）
		expect(body.raw.split("\n")).toHaveLength(6);
		expect(body.raw).toContain("user: 内容2");
		expect(body.raw).not.toContain("内容1\n");
		expect(body.raw).toContain(`user: ${"备".repeat(200)}`);
		expect(body.raw).not.toContain("备".repeat(201));
		expect(body.preferences).toEqual([]);
		expect(body.adoptedPlans).toEqual([]);
		expect(body.concerns).toEqual([]);
		expect(body.opportunities).toEqual([]);
	});

	it("putSummary 抛错时向上透传（rejects）", async () => {
		const putSummary = vi.fn().mockRejectedValue(new Error("PUT failed"));
		const runLlmOnce = vi.fn().mockResolvedValue({ parsed: { raw: "ok" }, rawText: "{}" });
		const fetchExisting = vi.fn().mockResolvedValue(undefined);

		await expect(
			runRefreshCustomerSummary(
				{ customerId: "CUST_003", managerId: "MGR_001", messages: [] },
				"/tmp/agent",
				{ runLlmOnce, putSummary, fetchExisting },
			),
		).rejects.toThrow("PUT failed");
	});
});
