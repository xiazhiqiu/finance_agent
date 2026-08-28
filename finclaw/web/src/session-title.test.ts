import { describe, expect, it } from "vitest";
import { defaultSessionTitle, isOldPlaceholderTitle } from "./session-title.ts";

describe("defaultSessionTitle", () => {
  it("生成「客户名 - 营销会话 - YYYYMMDD」默认标题", () => {
    expect(defaultSessionTitle("张三", "2026-08-14T10:30:00.000Z")).toBe(
      "张三 - 营销会话 - 20260814",
    );
  });

  it("客户名为空时返回空字符串", () => {
    expect(defaultSessionTitle("", "2026-08-14T10:30:00.000Z")).toBe("");
  });

  it("客户名全空白时返回空字符串", () => {
    expect(defaultSessionTitle("   ", "2026-08-14T10:30:00.000Z")).toBe("");
  });

  it("非 ISO 日期字符串时回退到基于当前日期的标题", () => {
    const title = defaultSessionTitle("张三", "not-a-date");
    expect(title).toMatch(/^.+ - 营销会话 - \d{8}$/);
    expect(title).not.toBe("");
  });
});

describe("isOldPlaceholderTitle", () => {
  it("识别旧占位名标题", () => {
    expect(isOldPlaceholderTitle("2026-08-14 对话")).toBe(true);
  });

  it("不识别新默认标题", () => {
    expect(isOldPlaceholderTitle("张三 - 营销会话 - 20260814")).toBe(false);
  });

  it("空字符串返回 false", () => {
    expect(isOldPlaceholderTitle("")).toBe(false);
  });
});
