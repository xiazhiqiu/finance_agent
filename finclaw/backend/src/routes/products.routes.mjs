// 产品 / 营销策略路由
export default async function register(ctx) {
  const { request, response, url, origin, json, store, seed, STRATEGIES } = ctx;
  const customerById = (id) => seed.customers.find((item) => item.customerId === id);

  if (request.method === "GET" && url.pathname === "/api/products/eligible") {
    const customer = customerById(url.searchParams.get("customerId"));
    if (!customer) return json(response, 404, { error: "客户不存在" }, origin);
    const maxRisk = customer.riskTolerance ? Number(customer.riskTolerance.replace("C", "")) : 5;
    const products = seed.products.filter((item) => item.onSale && item.availableQuota > 0 && Number(item.riskLevel.replace("R", "")) <= maxRisk);
    return json(response, 200, products, origin);
  }

  if (request.method === "GET" && url.pathname === "/api/products/strategies") return json(response, 200, seed.strategies, origin);

  // 产品全字段详情（前端点击产品详情用；不校验在售/配额，仅按 ID 取数）
  const productDetail = url.pathname.match(/^\/api\/products\/([^/]+)$/);
  if (request.method === "GET" && productDetail) {
    const product = seed.products.find((item) => item.productId === decodeURIComponent(productDetail[1]));
    if (!product) return json(response, 404, { error: "产品不存在" }, origin);
    return json(response, 200, product, origin);
  }

  // 营销策略列表（M3.1）
  if (request.method === "GET" && url.pathname === "/api/strategies") {
    return json(response, 200, STRATEGIES, origin);
  }

  return false;
}