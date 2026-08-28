import assert from "node:assert/strict";
import test from "node:test";
import { composeKnowledgeMarkdown, parseKnowledgeMarkdown } from "./knowledge.mjs";

test("composes the five knowledge sections", () => {
  assert.equal(
    composeKnowledgeMarkdown({
      talkTemplates: "先确认客户需求。",
      productPriority: "优先短期限产品。",
      stylePreference: "简洁、专业。",
      compliance: "避免承诺收益。",
      followUp: "到期前一周提醒。",
    }),
    "### 话术模板\n\n先确认客户需求。\n\n### 产品优先度\n\n优先短期限产品。\n\n### 风格偏好\n\n简洁、专业。\n\n### 合规经验\n\n避免承诺收益。\n\n### 跟进策略\n\n到期前一周提醒。\n",
  );
});

test("composes five sections with empty content for missing fields", () => {
  assert.equal(
    composeKnowledgeMarkdown({
      talkTemplates: "先确认客户需求。",
      productPriority: "优先短期限产品。",
      stylePreference: "简洁、专业。",
    }),
    "### 话术模板\n\n先确认客户需求。\n\n### 产品优先度\n\n优先短期限产品。\n\n### 风格偏好\n\n简洁、专业。\n\n### 合规经验\n\n\n\n### 跟进策略\n\n\n",
  );
});

test("parses existing markdown into editable fields", () => {
  assert.deepEqual(
    parseKnowledgeMarkdown("### 话术模板\r\n\r\n模板 A\r\n\r\n### 产品优先度\r\n\r\nP001\r\n\r\n### 风格偏好\r\n\r\n自然"),
    { talkTemplates: "模板 A", productPriority: "P001", stylePreference: "自然", compliance: "", followUp: "" },
  );
});

test("parses old three-section markdown without error (兼容旧数据)", () => {
  const result = parseKnowledgeMarkdown("### 话术模板\n\n模板 A\n\n### 产品优先度\n\nP001");
  assert.equal(result.talkTemplates, "模板 A");
  assert.equal(result.productPriority, "P001");
  assert.equal(result.compliance, "");
  assert.equal(result.followUp, "");
});
