import { describe, expect, it } from "vitest";
import { extractMessageText, parseGenerateResult } from "./result-parser.ts";

describe("parseGenerateResult", () => {
  it("parses fenced agent output", () => {
    const result = parseGenerateResult('结果如下：\n```json\n{"plans":[],"attempt":1}\n```');
    expect(result).toEqual({ plans: [], attempt: 1 });
  });

  it("extracts text content blocks", () => {
    expect(extractMessageText({ content: [{ type: "text", text: "ok" }] })).toBe("ok");
  });
});
