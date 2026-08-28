import test from "node:test";
import assert from "node:assert/strict";
import { auditPlans } from "./compliance.mjs";

const customer = { riskTolerance: "C3" };
const products = [
  { productId: "P1", name: "稳健产品", riskLevel: "R2", onSale: true, availableQuota: 10 },
  { productId: "P2", name: "高风险产品", riskLevel: "R4", onSale: true, availableQuota: 10 },
  { productId: "P3", name: "下架产品", riskLevel: "R2", onSale: false, availableQuota: 10 },
  { productId: "P4", name: "售罄产品", riskLevel: "R2", onSale: true, availableQuota: 0 },
];

test("passes an eligible plan with disclosure", () => {
  const report = auditPlans(customer, products, [
    {
      title: "稳健方案",
      products: [{ productId: "P1", name: "稳健产品", riskLevel: "R2" }],
      scripts: { wecom: "请结合自身情况审慎决策" },
      markdown: "理财有风险，投资需谨慎",
    },
  ]);
  assert.equal(report.passed, true);
  assert.deepEqual(report.mismatchedProducts, []);
  assert.deepEqual(report.offSaleProducts, []);
});

test("rejects risk mismatch and forbidden promises", () => {
  const report = auditPlans(customer, products, [
    {
      title: "违规方案",
      products: [{ productId: "P2", name: "高风险产品", riskLevel: "R4" }],
      scripts: { wecom: "稳赚不赔" },
      markdown: "无提示",
    },
  ]);
  assert.equal(report.passed, false);
  assert.equal(report.riskMismatch, true);
  assert.equal(report.forbiddenWords[0]?.word, "稳赚不赔");
  assert.deepEqual(report.mismatchedProducts, [
    { productId: "P2", name: "高风险产品", reason: "产品风险等级 R4 高于客户承受等级 C3" },
  ]);
});

test("rejects off-sale, sold-out and missing products", () => {
  const report = auditPlans(customer, products, [
    {
      title: "问题方案",
      products: [
        { productId: "P3", name: "下架产品", riskLevel: "R2" },
        { productId: "P4", name: "售罄产品", riskLevel: "R2" },
        { productId: "P999", name: "不存在产品", riskLevel: "R2" },
      ],
      scripts: { wecom: "请结合自身情况审慎决策" },
      markdown: "理财有风险，投资需谨慎",
    },
  ]);
  assert.equal(report.passed, false);
  assert.deepEqual(report.offSaleProducts, [
    { productId: "P3", name: "下架产品", reason: "产品已下架" },
    { productId: "P4", name: "售罄产品", reason: "产品配额不足" },
    { productId: "P999", name: "不存在产品", reason: "产品不存在" },
  ]);
});
