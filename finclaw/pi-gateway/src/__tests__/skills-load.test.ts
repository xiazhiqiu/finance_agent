import { describe, it, expect } from "vitest";
import {
	loadSkillsFromDir,
	formatSkillsForPrompt,
	type Skill,
} from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { dirname, resolve, basename } from "node:path";

// finclaw 目录：src/__tests__/ 上溯三级（src → pi-gateway → finclaw）；skills 位于 finclaw/.pi/skills
const finclawDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function loadProjectSkills() {
	return loadSkillsFromDir({
		dir: resolve(finclawDir, ".pi", "skills"),
		source: "project",
	});
}

describe("Pi SDK SKILL 插件加载", () => {
	it("能够从 .pi/skills/ 发现 market-analysis 与 product-recommend 两个 SKILL", () => {
		const { skills } = loadProjectSkills();
		const names = skills.map((s: Skill) => s.name).sort();
		expect(names).toEqual(["market-analysis", "product-recommend"]);
	});

	it("SKILL 的 description 为必填、非空", () => {
		const { skills } = loadProjectSkills();
		expect(skills).toHaveLength(2);
		for (const s of skills) {
			expect(s.description).toBeTruthy();
			expect(s.description.trim().length).toBeGreaterThan(0);
		}
	});

	it("SKILL 指向目录内的 SKILL.md 文件（目录结构）", () => {
		const { skills } = loadProjectSkills();
		const market = skills.find((s: Skill) => s.name === "market-analysis");
		const product = skills.find((s: Skill) => s.name === "product-recommend");
		// name 与父目录一致，且加载的文件即为 <skill>/SKILL.md
		expect(market).toBeDefined();
		expect(product).toBeDefined();
		expect(basename(market!.filePath)).toBe("SKILL.md");
		expect(basename(dirname(market!.filePath))).toBe("market-analysis");
		expect(basename(product!.filePath)).toBe("SKILL.md");
		expect(basename(dirname(product!.filePath))).toBe("product-recommend");
	});

	it("SKILL 归属项目作用域（project）", () => {
		const { skills } = loadProjectSkills();
		for (const s of skills) {
			expect(s.sourceInfo?.scope).toBe("project");
		}
	});

	it("SKILL 无校验诊断告警（name 合法、description 未超长）", () => {
		const { diagnostics } = loadProjectSkills();
		const warnings = diagnostics.filter((d) => d.type === "warning");
		expect(warnings).toEqual([]);
	});

	it("formatSkillsForPrompt 将 SKILL 描述注入系统提示（渐进式披露）", () => {
		const { skills } = loadProjectSkills();
		const prompt = formatSkillsForPrompt(skills);
		expect(prompt).toContain("market-analysis");
		expect(prompt).toContain("product-recommend");
		// 触发描述出现在 XML 描述字段中
		expect(prompt).toContain("当前市场环境");
		expect(prompt).toContain("理财产品组合");
	});

	it("两个 SKILL 均可通过 /skill:name 命令调用（未被禁用模型调用）", () => {
		const { skills } = loadProjectSkills();
		for (const s of skills) {
			expect(s.disableModelInvocation).toBe(false);
		}
	});
});