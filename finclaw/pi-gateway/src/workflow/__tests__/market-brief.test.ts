import { describe, it, expect } from "vitest";
import { buildMarketBriefPrompt } from "../market-brief.ts";

describe("buildMarketBriefPrompt", () => {
	it("包含三维框架与配置含义维度", () => {
		const prompt = buildMarketBriefPrompt();
		expect(prompt).toContain("利率环境");
		expect(prompt).toContain("权益市场");
		expect(prompt).toContain("汇率趋势");
		expect(prompt).toContain("配置含义");
	});

	it("要求 JSON 输出与长度约束", () => {
		const prompt = buildMarketBriefPrompt();
		expect(prompt).toContain('{ "content": "简报全文" }');
		expect(prompt).toContain("100-300 字");
	});

	it("注入当前日期", () => {
		const today = new Date().toISOString().slice(0, 10);
		expect(buildMarketBriefPrompt()).toContain(today);
	});
});
