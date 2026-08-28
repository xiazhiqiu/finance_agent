// 知识库路由
export default async function register(ctx) {
  const { request, response, url, session, origin, json, readBody, store, auth, knowledge, forwardGateway } = ctx;
  const managerId = session.managerId;

  if (request.method === "GET" && url.pathname === "/api/knowledge") {
    const content = await store.getKnowledge(managerId);
    return json(response, 200, { ...knowledge.parseKnowledgeMarkdown(content), content }, origin);
  }

  if (request.method === "POST" && url.pathname === "/api/knowledge/save") {
    const body = await readBody(request);
    const fields = body.content ? knowledge.parseKnowledgeMarkdown(body.content) : body;
    const content = knowledge.composeKnowledgeMarkdown(fields);
    await store.saveKnowledge(managerId, content);
    return json(response, 200, { success: true, content }, origin);
  }

  // M4.2 · 知识库沉淀建议（转发到 pi-gateway /api/knowledge/suggest）
  if (request.method === "POST" && url.pathname === "/api/knowledge/suggest") {
    const body = await readBody(request);
    if (!body.customerId || !body.plan) return json(response, 400, { error: "customerId 和 plan 为必填" }, origin);
    const assignedIds = await auth.getAssignedCustomers(managerId);
    if (!assignedIds.includes(body.customerId)) return json(response, 403, { error: "无权访问该客户" }, origin);

    let data;
    try {
      data = await forwardGateway("/api/knowledge/suggest", { customerId: body.customerId, managerId, plan: body.plan }, managerId);
    } catch (err) {
      return json(response, err.status || 500, { error: err.message }, origin);
    }

    // M3 · 提取结果写入待确认区（PRD §3.5.1：方案采纳提取进入 pending，经理确认后并入知识库）
    // 类别 → 知识库段字段（与 pi-gateway save-knowledge.ts 的 CATEGORY_TO_FIELD 一致）
    const EXTRA_FIELD = {
      combinationStrategy: "productPriority",
      compliance: "compliance",
      objectionHandling: "talkTemplates",
      followUp: "followUp",
    };
    const pendingItems = [];
    const pushPending = (field, content) => {
      const text = String(content || "").trim();
      if (text) pendingItems.push({ managerId, field, content: text, source: "suggest" });
    };
    if (data && typeof data === "object") {
      pushPending("talkTemplates", data.talkTemplates);
      pushPending("productPriority", data.productPriority);
      pushPending("stylePreference", data.stylePreference);
      for (const item of Array.isArray(data.extra) ? data.extra : []) {
        pushPending(EXTRA_FIELD[item?.category] || "talkTemplates", item?.content);
      }
    }
    if (pendingItems.length > 0) await store.addPendingKnowledge(pendingItems);

    return json(response, 200, data, origin);
  }

  // M5.2 · 记忆沉淀候选分析（转发到 pi-gateway /api/knowledge/candidates）
  if (request.method === "POST" && url.pathname === "/api/knowledge/candidates") {
    const body = await readBody(request);
    if (!body.sessionKey || !body.customerId) return json(response, 400, { error: "sessionKey 和 customerId 为必填" }, origin);
    const assignedIds = await auth.getAssignedCustomers(managerId);
    if (!assignedIds.includes(body.customerId)) return json(response, 403, { error: "无权访问该客户" }, origin);

    try {
      const data = await forwardGateway(
        "/api/knowledge/candidates",
        { customerId: body.customerId, managerId, sessionKey: body.sessionKey },
        managerId,
      );
      return json(response, 200, data, origin);
    } catch (err) {
      return json(response, err.status || 500, { error: err.message }, origin);
    }
  }

  // M5.2 · 批量应用用户确认的候选知识（并入知识库对应段）
  if (request.method === "POST" && url.pathname === "/api/knowledge/apply") {
    const body = await readBody(request);
    const items = Array.isArray(body?.items) ? body.items : [];
    if (items.length === 0) return json(response, 400, { error: "items 为必填" }, origin);

    // 类别 → 知识库段字段（与 pi-gateway 候选类别一致；组合策略并入产品优先度、异议话术并入话术模板）
    const CANDIDATE_FIELD = {
      talkTemplates: "talkTemplates",
      productPriority: "productPriority",
      stylePreference: "stylePreference",
      combinationStrategy: "productPriority",
      compliance: "compliance",
      objectionHandling: "talkTemplates",
      followUp: "followUp",
    };

    const current = await store.getKnowledge(managerId);
    const fields = knowledge.parseKnowledgeMarkdown(current);
    let applied = 0;
    for (const item of items) {
      const content = String(item?.content || "").trim();
      if (!content) continue;
      const field = CANDIDATE_FIELD[item?.category] || "talkTemplates";
      const existing = String(fields[field] || "").trim();
      fields[field] = existing ? `${existing}\n${content}` : content;
      applied++;
    }
    await store.saveKnowledge(managerId, knowledge.composeKnowledgeMarkdown(fields));
    return json(response, 200, { success: true, applied }, origin);
  }

  // M3 · 待确认知识列表
  if (request.method === "GET" && url.pathname === "/api/knowledge/pending") {
    const pending = await store.listPendingKnowledge(managerId);
    return json(response, 200, pending, origin);
  }

  // M3 · 批量确认待确认知识（并入知识库对应段后删除记录）
  if (request.method === "POST" && url.pathname === "/api/knowledge/confirm-pending") {
    const body = await readBody(request);
    const ids = Array.isArray(body?.ids) ? body.ids.filter((id) => typeof id === "string") : [];
    if (ids.length === 0) return json(response, 400, { error: "ids 为必填" }, origin);

    const pending = await store.listPendingKnowledge(managerId);
    const targets = pending.filter((p) => ids.includes(p.id) && p.status === "pending");
    if (targets.length === 0) return json(response, 200, { confirmed: [] }, origin);

    // 并入知识库对应段（读-改-写）
    const current = await store.getKnowledge(managerId);
    const fields = knowledge.parseKnowledgeMarkdown(current);
    for (const item of targets) {
      const field = item.field && item.field in fields ? item.field : "talkTemplates";
      const existing = String(fields[field] || "").trim();
      fields[field] = existing ? `${existing}\n${item.content}` : item.content;
    }
    await store.saveKnowledge(managerId, knowledge.composeKnowledgeMarkdown(fields));

    const confirmed = await store.deletePendingKnowledge(ids);
    return json(response, 200, { confirmed }, origin);
  }

  // M3 · 批量拒绝待确认知识（拒绝即删除，不保留记录）
  if (request.method === "POST" && url.pathname === "/api/knowledge/reject-pending") {
    const body = await readBody(request);
    const ids = Array.isArray(body?.ids) ? body.ids.filter((id) => typeof id === "string") : [];
    if (ids.length === 0) return json(response, 400, { error: "ids 为必填" }, origin);
    const rejected = await store.deletePendingKnowledge(ids);
    return json(response, 200, { rejected }, origin);
  }

  return false;
}