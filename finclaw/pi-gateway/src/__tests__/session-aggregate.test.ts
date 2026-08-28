import { describe, it, expect } from "vitest";
import type { UserMessage, AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import type { SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import {
	aggregateSessionEntries,
	stripContextPrefix,
} from "../session-aggregate.ts";

let seq = 0;
function entry(
	message: UserMessage | AssistantMessage | ToolResultMessage,
	timestamp = "2026-01-01T00:00:00.000Z",
): SessionMessageEntry {
	seq += 1;
	return { type: "message", id: `id-${seq}`, parentId: null, timestamp, message };
}

function user(content: string, ts = "2026-01-01T00:00:00.000Z"): UserMessage {
	return { role: "user", content, timestamp: Date.parse(ts) };
}

function assistant(content: string, ts = "2026-01-01T00:00:01.000Z"): AssistantMessage {
	return {
		role: "assistant",
		content: content ? [{ type: "text", text: content }] : [],
		api: "anthropic",
		provider: "anthropic",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.parse(ts),
	};
}

function toolResult(
	content: string,
	ts = "2026-01-01T00:00:02.000Z",
	details?: unknown,
): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "generate_plan",
		content: [{ type: "text", text: content }],
		isError: false,
		timestamp: Date.parse(ts),
		...(details ? { details } : {}),
	};
}

describe("aggregateSessionEntries", () => {
	it("单轮：1 条 user + 1 条 assistant 聚合为 1 问 1 答", () => {
		const entries = [entry(user("你好"), "2026-01-01T00:00:00.000Z"), entry(assistant("你好，有什么可以帮你？"), "2026-01-01T00:00:01.000Z")];
		const result = aggregateSessionEntries(entries);
		expect(result).toHaveLength(2);
		expect(result[0]).toMatchObject({ role: "user", content: "你好" });
		expect(result[1]).toMatchObject({
			role: "assistant",
			content: "你好，有什么可以帮你？",
			timestamp: "2026-01-01T00:00:01.000Z",
		});
	});

	it("工具轮：工具步骤与工具文本并入回答，plans 不再从文本解析", () => {
		const entries = [
			entry(user("请帮我生成一份理财方案"), "2026-01-01T00:00:00.000Z"),
			entry(assistant("", "2026-01-01T00:00:01.000Z")), // 工具调用，文本为空
			entry(
				toolResult("```json\n{ \"plans\": [{ \"planId\": \"P1\", \"title\": \"稳健配置\" }] }\n```"),
				"2026-01-01T00:00:02.000Z",
			),
			entry(assistant("已为您生成以下方案。"), "2026-01-01T00:00:03.000Z"),
		];
		const result = aggregateSessionEntries(entries);
		expect(result).toHaveLength(2);
		expect(result[0]).toMatchObject({ role: "user", content: "请帮我生成一份理财方案" });
		expect(result[1]).toMatchObject({
			role: "assistant",
			content: "```json\n{ \"plans\": [{ \"planId\": \"P1\", \"title\": \"稳健配置\" }] }\n```\n已为您生成以下方案。",
			timestamp: "2026-01-01T00:00:03.000Z",
		});
		// 完整方案改走工具结果 details 通道，聚合不再从文本提取 plans
		expect(result[1].plans).toBeUndefined();
	});

	it("details 通道：toolResult 携带 details.result 时，plans 透传到聚合回答", () => {
		const entries = [
			entry(user("请帮我生成一份理财方案"), "2026-01-01T00:00:00.000Z"),
			entry(assistant("", "2026-01-01T00:00:01.000Z")), // 工具调用，文本为空
			entry(
				toolResult(
					"已为客户生成 3 套方案（含合规审查结果）。",
					"2026-01-01T00:00:02.000Z",
					{
						success: true,
						kind: "generate_plan",
						result: {
							plans: [
								{ planId: "P1", title: "稳健配置", score: 90 },
								{ planId: "P2", title: "进取配置", score: 78 },
							],
							complianceReport: { passed: true },
						},
					},
				),
			),
			entry(assistant("已为您生成以下方案。"), "2026-01-01T00:00:03.000Z"),
		];
		const result = aggregateSessionEntries(entries);
		expect(result).toHaveLength(2);
		expect(result[1]).toMatchObject({
			role: "assistant",
			content: "已为客户生成 3 套方案（含合规审查结果）。\n已为您生成以下方案。",
		});
		expect(result[1].plans).toMatchObject({
			plans: [
				{ planId: "P1", title: "稳健配置", score: 90 },
				{ planId: "P2", title: "进取配置", score: 78 },
			],
			complianceReport: { passed: true },
		});
	});

	it("details 通道：非方案工具（customer_analyze）不产生 plans", () => {
		const entries = [
			entry(user("请分析该客户"), "2026-01-01T00:00:00.000Z"),
			entry(assistant("", "2026-01-01T00:00:01.000Z")),
			entry(
				{
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "customer_analyze",
					content: [{ type: "text", text: "分析完成" }],
					isError: false,
					timestamp: Date.parse("2026-01-01T00:00:02.000Z"),
					details: { customerId: "CUST_001", success: true },
				} as ToolResultMessage,
				"2026-01-01T00:00:02.000Z",
			),
			entry(assistant("分析完成。"), "2026-01-01T00:00:03.000Z"),
		];
		const result = aggregateSessionEntries(entries);
		expect(result).toHaveLength(2);
		expect(result[1].plans).toBeUndefined();
	});

	it("摘要格式工具轮：content 为摘要文本，不解析为 plans", () => {
		const entries = [
			entry(user("请帮我生成一份理财方案"), "2026-01-01T00:00:00.000Z"),
			entry(assistant("", "2026-01-01T00:00:01.000Z")), // 工具调用，文本为空
			entry(
				toolResult("已为客户生成 3 套方案（含合规审查结果）。\n\n- 方案 A [plan-CUST_001-A] 稳健配置 · 90 分 · 防御型\n- 方案 B [plan-CUST_001-B] 进取配置 · 78 分 · 权益类\n\n合规审查：全部通过"),
				"2026-01-01T00:00:02.000Z",
			),
			entry(assistant("已为您生成以下方案。"), "2026-01-01T00:00:03.000Z"),
		];
		const result = aggregateSessionEntries(entries);
		expect(result[1]).toMatchObject({
			role: "assistant",
			content:
				"已为客户生成 3 套方案（含合规审查结果）。\n\n- 方案 A [plan-CUST_001-A] 稳健配置 · 90 分 · 防御型\n- 方案 B [plan-CUST_001-B] 进取配置 · 78 分 · 权益类\n\n合规审查：全部通过\n已为您生成以下方案。",
			timestamp: "2026-01-01T00:00:03.000Z",
		});
		// 摘要文本不再被当作完整方案解析
		expect(result[1].plans).toBeUndefined();
	});

	it("多轮：连续两问两答正确交替", () => {
		const entries = [
			entry(user("第一问"), "2026-01-01T00:00:00.000Z"),
			entry(assistant("第一答"), "2026-01-01T00:00:01.000Z"),
			entry(user("第二问"), "2026-01-01T00:00:02.000Z"),
			entry(assistant("第二答"), "2026-01-01T00:00:03.000Z"),
		];
		const result = aggregateSessionEntries(entries);
		expect(result).toHaveLength(4);
		expect(result.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
		expect(result.map((m) => m.content)).toEqual(["第一问", "第一答", "第二问", "第二答"]);
	});

	it("前缀剥离：user 内容带 [会话上下文] 前缀时被剥离", () => {
		const entries = [
			entry(user("[会话上下文] customer: CUST_001, manager: MGR_001\n\n你好")),
			entry(assistant("你好！")),
		];
		const result = aggregateSessionEntries(entries);
		expect(result[0]).toMatchObject({ role: "user", content: "你好" });
	});

	it("无 assistant 回复的 user 条目也照常输出", () => {
		const result = aggregateSessionEntries([entry(user("这条没有回复"))]);
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({ role: "user", content: "这条没有回复" });
		expect(result[0].plans).toBeUndefined();
	});
});

describe("stripContextPrefix", () => {
	it("移除 [会话上下文] 前缀行及其后的空行", () => {
		expect(stripContextPrefix("[会话上下文] customer: CUST_001\n\n你好")).toBe("你好");
	});
	it("无前缀时原样返回", () => {
		expect(stripContextPrefix("你好")).toBe("你好");
	});
});
