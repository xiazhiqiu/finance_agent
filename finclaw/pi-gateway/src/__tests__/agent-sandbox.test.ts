import { describe, it, expect } from "vitest";
import { isAgentSandboxEnabled } from "../agent-session.ts";

describe("Agent 运行沙箱开关（FINANCE_AGENT_SANDBOX）", () => {
	it("未设置时默认启用沙箱", () => {
		expect(isAgentSandboxEnabled({})).toBe(true);
	});

	it("显式置 '0' 时关闭沙箱", () => {
		expect(isAgentSandboxEnabled({ FINANCE_AGENT_SANDBOX: "0" })).toBe(false);
	});

	it("'1' 与其他非 '0' 值均保持启用", () => {
		expect(isAgentSandboxEnabled({ FINANCE_AGENT_SANDBOX: "1" })).toBe(true);
		expect(isAgentSandboxEnabled({ FINANCE_AGENT_SANDBOX: "yes" })).toBe(true);
	});
});