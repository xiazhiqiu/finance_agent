import { describe, it, expect } from "vitest";
import { escapeHtml, money, parseDiagnosisSections } from "./render-utils.ts";

describe("escapeHtml", () => {
  it("转义 HTML 特殊字符", () => {
    expect(escapeHtml('<a href="x">&</a>')).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;");
  });

  it("undefined/null 返回空串", () => {
    expect(escapeHtml(undefined)).toBe("");
    expect(escapeHtml(null)).toBe("");
  });
});

describe("money", () => {
  it("人民币格式化无小数", () => {
    expect(money(6800000)).toBe("¥6,800,000");
  });
});

describe("parseDiagnosisSections", () => {
  it("解析三段式诊断(带 | 分隔符)", () => {
    const input = "【资产配置】AUM 680 万，活期 80 万 | 【风险诊断】C3 平衡型客户 | 【任务诊断】到期承接(P100)";
    expect(parseDiagnosisSections(input)).toEqual([
      { title: "资产配置", content: "AUM 680 万，活期 80 万" },
      { title: "风险诊断", content: "C3 平衡型客户" },
      { title: "任务诊断", content: "到期承接(P100)" },
    ]);
  });

  it("内容含换行与 | 时正常解析", () => {
    const input = "【资产配置】第一段\n第二行 | 【风险诊断】风险段";
    const sections = parseDiagnosisSections(input);
    expect(sections).toHaveLength(2);
    expect(sections[0].content).toContain("第一段\n第二行");
    expect(sections[0].content).not.toContain("|");
  });

  it("无标签段落时返回空数组", () => {
    expect(parseDiagnosisSections("普通文本诊断")).toEqual([]);
  });

  it("undefined/空串返回空数组", () => {
    expect(parseDiagnosisSections(undefined)).toEqual([]);
    expect(parseDiagnosisSections("")).toEqual([]);
  });
});
