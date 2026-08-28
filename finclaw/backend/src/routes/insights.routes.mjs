// 洞察路由（M4/M4.2）
import { evaluateCustomer } from "../strategies.mjs";

export default async function register(ctx) {
  const { request, response, url, session, origin, json, readBody, store, auth, forwardGateway } = ctx;
  const managerId = session.managerId;

  if (request.method === "GET" && url.pathname === "/api/insights") {
    const filter = {};
    const customerId = url.searchParams.get("customerId");
    const status = url.searchParams.get("status");
    if (customerId) filter.customerId = customerId;
    if (status) filter.status = status;
    return json(response, 200, await store.listInsights(filter), origin);
  }

  if (request.method === "POST" && url.pathname === "/api/insights") {
    const body = await readBody(request);
    if (!body.customerId || !body.content) return json(response, 400, { error: "customerId 和 content 为必填" }, origin);
    const assignedIds = await auth.getAssignedCustomers(managerId);
    if (!assignedIds.includes(body.customerId)) return json(response, 403, { error: "无权访问该客户" }, origin);
    const insight = await store.addInsight({ customerId: body.customerId, content: body.content, tags: body.tags || [], source: body.source || "llm" });
    return json(response, 201, insight, origin);
  }

  // M4.1 · 方案接受触发洞察提取（双源汇聚的"方案接受"通道）
  // 转发到 pi-gateway /api/insight/extract，将结果写入 insights[]，source='accepted'
  if (request.method === "POST" && url.pathname === "/api/insights/extract") {
    const body = await readBody(request);
    if (!body.customerId || !body.plan) return json(response, 400, { error: "customerId 和 plan 为必填" }, origin);
    const assignedIds = await auth.getAssignedCustomers(managerId);
    if (!assignedIds.includes(body.customerId)) return json(response, 403, { error: "无权访问该客户" }, origin);

    let extracted;
    try {
      extracted = await forwardGateway("/api/insight/extract", { customerId: body.customerId, managerId, plan: body.plan }, managerId);
    } catch (err) {
      return json(response, err.status || 500, { error: err.message }, origin);
    }
    const insight = await store.addInsight({
      customerId: body.customerId,
      content: extracted.content,
      tags: extracted.tags || ["方案洞察"],
      source: "accepted",
    });
    return json(response, 201, insight, origin);
  }

  const insightConfirmMatch = url.pathname.match(/^\/api\/insights\/([^/]+)\/confirm$/);
  if (request.method === "PUT" && insightConfirmMatch) {
    const insightId = decodeURIComponent(insightConfirmMatch[1]);
    const insight = await store.confirmInsight(insightId);
    if (!insight) return json(response, 404, { error: "洞察不存在" }, origin);
    // C1：确认洞察后，触发该客户规则任务 Y1 重算（近期任务刷新为最新策略命中）
    const customer = store.seed.customers.find((c) => c.customerId === insight.customerId);
    if (customer) {
      await store.mergeTasksForCustomer(customer.customerId, evaluateCustomer(customer));
    }
    return json(response, 200, insight, origin);
  }

  const insightRejectMatch = url.pathname.match(/^\/api\/insights\/([^/]+)\/reject$/);
  if (request.method === "PUT" && insightRejectMatch) {
    const insightId = decodeURIComponent(insightRejectMatch[1]);
    const insight = await store.rejectInsight(insightId);
    return insight ? json(response, 200, insight, origin) : json(response, 404, { error: "洞察不存在" }, origin);
  }

  return false;
}