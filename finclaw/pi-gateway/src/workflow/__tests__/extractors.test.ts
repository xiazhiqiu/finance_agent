import { describe, it, expect } from "vitest";
import {
	buildExtractionPrompt,
	parseExtractionResult,
	guessCategory,
	parseCandidatesResult,
	type KnowledgeCategory,
} from "../extractors.ts";
import type { CustomerProfile, MarketingPlan } from "../types.ts";

function makeCustomer(): CustomerProfile {
	return {
		customerId: "CUST_001",
		name: "张明远",
		riskTolerance: "R2",
		aum: 800000,
		segment: "退休",
	};
}

function makePlan(): MarketingPlan {
	return {
		planId: "plan-A",
		customerId: "CUST_001",
		title: "退休稳健配置方案",
		score: 8,
		tags: ["稳健"],
		diagnosis: "退休阶段，偏好固收",
		allocation: { 固收理财: { pct: 50, products: ["产品A"] } },
		products: [{ productId: "P001", name: "产品A", category: "固收理财", riskLevel: "R2", reason: "稳健增值" }],
		scripts: { wecom: "您好，为您推荐稳健配置", phone: [] },
		markdown: "",
	};
}

describe("buildExtractionPrompt", () => {
	it("包含客户画像/提取源/去重参考/提取要求/输出要求 五段", () => {
		const prompt = buildExtractionPrompt({
			category: "talkTemplates",
			plan: makePlan(),
			customer: makeCustomer(),
			existingKnowledge: "### 话术模板\n已有一段话术",
			existingInsights: [{ content: "客户偏好保守" }],
			managerId: "m1",
		});
		expect(prompt).toContain("## 客户画像");
		expect(prompt).toContain("## 提取源（被采纳的方案）");
		expect(prompt).toContain("## 现有知识库（供去重参考");
		expect(prompt).toContain("## 现有洞察（供去重参考");
		expect(prompt).toContain("## 提取要求");
		expect(prompt).toContain("## 输出要求");
		expect(prompt).toContain("已有一段话术");
		expect(prompt).toContain("客户偏好保守");
	});

	it("类别要求差异:customerInsight 关注客户特征而非话术", () => {
		const prompt = buildExtractionPrompt({
			category: "customerInsight",
			conversation: "客户说最近市场波动大，比较担心",
			customer: makeCustomer(),
			managerId: "m1",
		});
		expect(prompt).toContain("## 提取源（对话/指令）");
		expect(prompt).toContain("隐性偏好");
	});

	it("category=combinationStrategy 时只注入方案源,不注入对话源", () => {
		const prompt = buildExtractionPrompt({
			category: "combinationStrategy",
			plan: makePlan(),
			conversation: "对话内容",
			customer: makeCustomer(),
			managerId: "m1",
		});
		expect(prompt).toContain("## 提取源（被采纳的方案）");
		expect(prompt).not.toContain("## 提取源（对话/指令）");
	});
});

describe("parseExtractionResult", () => {
	it("解析合法输出", () => {
		const result = parseExtractionResult(
			{
				content: "开场话术：您好我是您的理财经理",
				tags: ["话术"],
				summary: "从方案话术提炼",
				confidence: "high",
				isEmpty: false,
			},
			"talkTemplates",
		);
		expect(result.content).toBe("开场话术：您好我是您的理财经理");
		expect(result.tags).toEqual(["话术"]);
		expect(result.confidence).toBe("high");
		expect(result.isEmpty).toBe(false);
		expect(result.category).toBe("talkTemplates");
	});

	it("isEmpty=true → 空结果", () => {
		const result = parseExtractionResult(
			{ content: "", isEmpty: true },
			"followUp",
		);
		expect(result.isEmpty).toBe(true);
		expect(result.content).toBe("");
	});

	it("content 为空且未标记 isEmpty → 视为空结果", () => {
		const result = parseExtractionResult({ content: "  " }, "compliance");
		expect(result.isEmpty).toBe(true);
	});

	it("confidence 非法值 → 兜底为 low", () => {
		const result = parseExtractionResult(
			{ content: "x", confidence: "super" },
			"productPriority",
		);
		expect(result.confidence).toBe("low");
	});

	it("非对象输出(如纯文本) → 空结果且不抛错", () => {
		const result = parseExtractionResult("这不是 JSON", "talkTemplates");
		expect(result.isEmpty).toBe(true);
	});
});

describe("guessCategory", () => {
	it("category 参数优先", () => {
		expect(guessCategory("followUp", "客户说…")).toBe("followUp");
		expect(guessCategory("组合", "")).toBe("combinationStrategy");
	});
	it("内容关键词兜底", () => {
		expect(guessCategory(undefined, "客户拒绝时我会说…")).toBe("objectionHandling");
		expect(guessCategory("", "推荐稳健产品优先")).toBe("productPriority");
	});
	it("无匹配时默认 customerInsight", () => {
		expect(guessCategory(undefined, "客户最近在关注市场")).toBe("customerInsight");
	});
});

describe("parseCandidatesResult", () => {
	it("解析合法数组并裁剪到 5 条", () => {
		const parsed = Array.from({ length: 8 }, (_, i) => ({
			category: "talkTemplates",
			content: `经验 ${i}`,
			tags: ["a", "b"],
			summary: "摘要",
			confidence: "high",
		}));
		expect(parseCandidatesResult(parsed)).toHaveLength(5);
	});
	it("兼容 { candidates } / { items } 包装", () => {
		const item = { category: "compliance", content: "避免承诺收益", summary: "合规", confidence: "low" };
		expect(parseCandidatesResult({ candidates: [item] })).toHaveLength(1);
		expect(parseCandidatesResult({ items: [item] })[0].category).toBe("compliance");
	});
	it("过滤无效项并兜底类别", () => {
		const result = parseCandidatesResult([
			{ category: "unknown", content: " 有效内容 " },
			{ category: "stylePreference", content: "" },
			null,
			"not-an-object",
		]);
		expect(result).toHaveLength(1);
		expect(result[0].category).toBe("talkTemplates");
		expect(result[0].content).toBe("有效内容");
	});
});
