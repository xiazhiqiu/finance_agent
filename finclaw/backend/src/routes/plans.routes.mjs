// 方案（计划）路由
export default async function register(ctx) {
  const { request, response, url, origin, json, readBody, store, seed, compliance } = ctx;
  const customerById = (id) => seed.customers.find((item) => item.customerId === id);

  if (request.method === "POST" && url.pathname === "/api/plans/audit") {
    const body = await readBody(request);
    const customer = customerById(body.customerId);
    if (!customer) return json(response, 404, { error: "客户不存在" }, origin);
    return json(response, 200, compliance.auditPlans(customer, seed.products, body.plans || []), origin);
  }

  if (request.method === "POST" && url.pathname === "/api/plans/snapshots") return json(response, 201, await store.saveSnapshot(await readBody(request)), origin);

  const snapshots = url.pathname.match(/^\/api\/plans\/([^/]+)\/snapshots$/);
  if (request.method === "GET" && snapshots) return json(response, 200, await store.listSnapshots(decodeURIComponent(snapshots[1])), origin);

  return false;
}