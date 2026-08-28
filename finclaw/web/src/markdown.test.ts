import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown.ts";
import { stripJsonFence } from "./result-parser.ts";

describe("renderMarkdown", () => {
  it("renders headings, bold, lists and tables as HTML", () => {
    const html = renderMarkdown(
      "## 标题\n\n**加粗**\n\n- 甲\n- 乙\n\n| 列A | 列B |\n| --- | --- |\n| 1 | 2 |",
    );
    expect(html).toContain("<h2>");
    expect(html).toContain("<strong>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>");
    expect(html).toContain("<table>");
  });

  it("escapes raw HTML so script tags cannot execute", () => {
    const html = renderMarkdown("<script>alert(1)</script>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("stripJsonFence", () => {
  it("removes multiline json code blocks while keeping surrounding text", () => {
    const input = '开头\n```json\n{"plans":[1,2,3]}\n```\n结尾';
    expect(stripJsonFence(input)).toBe("开头\n\n结尾");
  });

  it("removes code blocks without a language tag", () => {
    const input = "前文\n```\nnot json\n```\n后文";
    expect(stripJsonFence(input)).toBe("前文\n\n后文");
  });

  it("returns plain text unchanged when there is no code block", () => {
    const text = "没有代码块\n只有普通文本";
    expect(stripJsonFence(text)).toBe(text);
  });
});
