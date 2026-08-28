// 方案会话持久化路由
export default async function register(ctx) {
  const { request, response, url, session, origin, json, readBody, store, auth } = ctx;
  const managerId = session.managerId;

  // 列出某客户的所有会话(按 updatedAt 降序)
  if (request.method === "GET" && url.pathname === "/api/sessions") {
    const customerId = url.searchParams.get("customerId") || "";
    if (!customerId) return json(response, 400, { error: "缺少 customerId 参数" }, origin);
    const internalToken = process.env.FINANCE_INTERNAL_TOKEN || "finance-internal-token-fallback";
    const isInternal = Boolean(internalToken && request.headers["x-internal-token"] === internalToken);
    if (!isInternal) {
      const assignedIds = await auth.getAssignedCustomers(managerId);
      if (!assignedIds.includes(customerId)) return json(response, 403, { error: "无权访问该客户" }, origin);
    }
    return json(response, 200, await store.listPlanSessions(customerId), origin);
  }

  // 获取单个会话详情
  const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (request.method === "GET" && sessionMatch) {
    const sessionId = decodeURIComponent(sessionMatch[1]);
    const session = await store.getPlanSession(sessionId);
    if (!session) return json(response, 404, { error: "会话不存在" }, origin);
    const assignedIds = await auth.getAssignedCustomers(managerId);
    if (!assignedIds.includes(session.customerId)) return json(response, 403, { error: "无权访问该会话" }, origin);
    return json(response, 200, session, origin);
  }

  // 新建会话
  if (request.method === "POST" && url.pathname === "/api/sessions") {
    const body = await readBody(request);
    const customerId = body.customerId || "";
    if (!customerId) return json(response, 400, { error: "缺少 customerId" }, origin);
    const assignedIds = await auth.getAssignedCustomers(managerId);
    if (!assignedIds.includes(customerId)) return json(response, 403, { error: "无权访问该客户" }, origin);
    const session = await store.createPlanSession({ customerId, managerId, title: body.title });
    return json(response, 201, session, origin);
  }

  // 更新会话(plans/selectedPlanId/adoptedPlanId/lastInstruction/complianceReport/title)
  if (request.method === "PUT" && sessionMatch) {
    const sessionId = decodeURIComponent(sessionMatch[1]);
    const existing = await store.getPlanSession(sessionId);
    if (!existing) return json(response, 404, { error: "会话不存在" }, origin);
    const assignedIds = await auth.getAssignedCustomers(managerId);
    if (!assignedIds.includes(existing.customerId)) return json(response, 403, { error: "无权访问该会话" }, origin);
    const body = await readBody(request);
    const patch = {};
    for (const key of ["plans", "selectedPlanId", "adoptedPlanId", "lastInstruction", "complianceReport", "title", "sessionKey"]) {
      if (body[key] !== undefined) patch[key] = body[key];
    }
    const updated = await store.updatePlanSession(sessionId, patch);
    return json(response, 200, updated, origin);
  }

  // 删除会话（级联删除方案快照；返回 sessionKey 供前端清理 gateway 对话历史）
  if (request.method === "DELETE" && sessionMatch) {
    const sessionId = decodeURIComponent(sessionMatch[1]);
    const existing = await store.getPlanSession(sessionId);
    if (!existing) return json(response, 404, { error: "会话不存在" }, origin);
    const assignedIds = await auth.getAssignedCustomers(managerId);
    if (!assignedIds.includes(existing.customerId)) return json(response, 403, { error: "无权访问该会话" }, origin);
    const deleted = await store.deletePlanSession(sessionId);
    return json(response, 200, { success: true, sessionKey: deleted?.sessionKey ?? null }, origin);
  }

  return false;
}