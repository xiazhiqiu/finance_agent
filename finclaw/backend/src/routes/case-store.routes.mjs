// 案例库路由（M3）：案例列表 / 删除
export default async function register(ctx) {
  const { request, response, url, session, origin, json, readBody, store, auth, forwardGateway } = ctx;
  const managerId = session.managerId;

  // M0 · 案例检索（转发到 pi-gateway /api/case-store/search，基于客户画像相似度检索）
  if (request.method === "POST" && url.pathname === "/api/case-store/search") {
    const body = await readBody(request);
    if (!body.customerId) return json(response, 400, { error: "customerId 为必填" }, origin);
    const assignedIds = await auth.getAssignedCustomers(managerId);
    if (!assignedIds.includes(body.customerId)) return json(response, 403, { error: "无权访问该客户" }, origin);

    let data;
    try {
      data = await forwardGateway("/api/case-store/search", { customerId: body.customerId, managerId, limit: body.limit }, managerId);
    } catch (err) {
      return json(response, err.status || 500, { error: err.message }, origin);
    }
    return json(response, 200, data, origin);
  }

  // 当前经理案例列表
  if (request.method === "GET" && url.pathname === "/api/case-store") {
    return json(response, 200, await store.listCases(managerId), origin);
  }

  // 删除单个案例
  const match = url.pathname.match(/^\/api\/case-store\/([^/]+)$/);
  if (request.method === "DELETE" && match) {
    const caseId = decodeURIComponent(match[1]);
    const removed = await store.deleteCase(caseId);
    return removed
      ? json(response, 200, { success: true }, origin)
      : json(response, 404, { error: "案例不存在" }, origin);
  }

  return false;
}
