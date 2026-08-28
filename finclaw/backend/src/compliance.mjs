const forbidden = ["保本保收益", "稳赚不赔", "刚性兑付", "零风险", "绝对收益"];
const disclosures = ["理财有风险，投资需谨慎", "基金过往业绩不预示未来表现"];

const level = (value) => Number.parseInt(String(value ?? "").replace(/\D/g, ""), 10) || 0;

export function auditPlans(customer, products, plans) {
  const productById = new Map(products.map((item) => [item.productId, item]));
  const mismatchedProducts = [];
  const offSaleProducts = [];
  const forbiddenWords = [];
  const missingRiskDisclosures = [];

  for (const plan of plans) {
    for (const recommended of plan.products ?? []) {
      const product = productById.get(recommended.productId);
      if (!product) {
        offSaleProducts.push({ productId: recommended.productId, name: recommended.name, reason: "产品不存在" });
      } else if (!product.onSale) {
        offSaleProducts.push({ productId: recommended.productId, name: recommended.name, reason: "产品已下架" });
      } else if (product.availableQuota <= 0) {
        offSaleProducts.push({ productId: recommended.productId, name: recommended.name, reason: "产品配额不足" });
      }
      const risk = product?.riskLevel ?? recommended.riskLevel;
      if (level(risk) > level(customer.riskTolerance)) mismatchedProducts.push({ productId: recommended.productId, name: recommended.name, reason: `产品风险等级 ${risk} 高于客户承受等级 ${customer.riskTolerance}` });
    }
    const text = JSON.stringify({ scripts: plan.scripts, markdown: plan.markdown });
    for (const word of forbidden) {
      if (text.includes(word)) forbiddenWords.push({ word, context: plan.title, suggestion: "删除承诺性表述并改为客观风险收益描述" });
    }
    if (!disclosures.some((item) => String(plan.markdown ?? "").includes(item))) {
      missingRiskDisclosures.push(`${plan.title} 缺少必要风险提示`);
    }
  }

  const passed = !mismatchedProducts.length && !offSaleProducts.length && !forbiddenWords.length && !missingRiskDisclosures.length;
  const summary = passed ? "全部方案通过合规审查" : "存在风险错配、产品状态或话术合规问题";
  return {
    passed,
    riskMismatch: mismatchedProducts.length > 0,
    mismatchedProducts: Array.from(new Map(mismatchedProducts.map((item) => [item.productId, item])).values()),
    offSaleProducts: Array.from(new Map(offSaleProducts.map((item) => [item.productId, item])).values()),
    forbiddenWords,
    missingRiskDisclosures,
    summary,
    markdown: `## 合规审查\n\n${summary}`,
  };
}
