import { filterCustomersByStrategy } from "../strategies.mjs";

// 客户画像 / 任务路由（客户经理专属）
export default async function register(ctx) {
  const { request, response, url, session, origin, json, readBody, store, auth, seed } = ctx;
  const managerId = session.managerId;
  const customerById = (id) => seed.customers.find((item) => item.customerId === id);

  if (request.method === "GET" && url.pathname === "/api/customers") {
    const assignedIds = await auth.getAssignedCustomers(managerId);
    let customers = seed.customers.filter((c) => assignedIds.includes(c.customerId));

    // 任务筛选（M3.2）：taskType + taskStatus + hasInsight
    const taskType = url.searchParams.get("taskType");
    const taskStatus = url.searchParams.get("taskStatus");
    const hasInsight = url.searchParams.get("hasInsight");

    if (taskType) {
      const matchedIds = new Set(filterCustomersByStrategy(customers, taskType));
      customers = customers.filter((c) => matchedIds.has(c.customerId));
    }

    // 附加 tasks + tags 到每个客户
    const enriched = await Promise.all(
      customers.map(async (c) => {
        const tasks = await store.getTasksForCustomer(c.customerId);
        const confirmedTags = await store.getConfirmedTagsForCustomer(c.customerId);
        const filteredTasks = taskStatus ? tasks.filter((t) => t.status === taskStatus) : tasks;
        return { ...c, tasks: filteredTasks, tags: confirmedTags };
      })
    );

    // hasInsight 筛选
    let result = enriched;
    if (hasInsight === "1" || hasInsight === "true") {
      const allInsights = await store.listInsights();
      const pendingCustomerIds = new Set(
        allInsights.filter((i) => i.status === "pending").map((i) => i.customerId)
      );
      result = enriched.filter((c) => pendingCustomerIds.has(c.customerId));
    }

    return json(response, 200, result, origin);
  }

  // 编辑客户画像（客户经理专属）
  const editProfile = url.pathname.match(/^\/api\/customers\/([^/]+)$/);
  if (request.method === "PUT" && editProfile) {
    const customerId = decodeURIComponent(editProfile[1]);
    const assignedIds = await auth.getAssignedCustomers(managerId);
    if (!assignedIds.includes(customerId)) return json(response, 403, { error: "无权编辑该客户" }, origin);
    const customer = customerById(customerId);
    if (!customer) return json(response, 404, { error: "客户不存在" }, origin);
    const body = await readBody(request);
    // 可编辑字段
    if (body.segment !== undefined) customer.segment = body.segment;
    if (body.occupation !== undefined) customer.occupation = body.occupation;
    if (body.riskTolerance !== undefined) customer.riskTolerance = body.riskTolerance;
    if (body.aumStructure !== undefined) {
      customer.aumStructure = body.aumStructure;
      // 后端校验 aum = sum(aumStructure)
      const computedAum = Object.values(body.aumStructure).reduce((sum, v) => sum + (Number(v) || 0), 0);
      if (body.aum !== undefined && body.aum !== computedAum) {
        return json(response, 400, { error: "AUM 与资产结构不匹配" }, origin);
      }
      customer.aum = computedAum;
    } else if (body.aum !== undefined) {
      customer.aum = body.aum;
    }
    if (body.upcomingMaturities !== undefined) customer.upcomingMaturities = body.upcomingMaturities;
    if (body.recentTransactions !== undefined) customer.recentTransactions = body.recentTransactions;
    if (body.lastContact !== undefined) customer.lastContact = body.lastContact;
    if (body.preferences !== undefined) customer.preferences = body.preferences;
    if (body.lifeCycleStage !== undefined) customer.lifeCycleStage = body.lifeCycleStage;
    if (body.riskAssessmentDate !== undefined) customer.riskAssessmentDate = body.riskAssessmentDate;
    if (body.birthday !== undefined) customer.birthday = body.birthday;
    // 编辑画像时回写最新洞察：覆盖该客户最新一条 insight 的 content（无洞察则忽略）
    if (typeof body.latestInsight === "string") {
      await store.updateLatestInsightContent(customerId, body.latestInsight);
    }
    return json(response, 200, customer, origin);
  }

  // 客户详情
  const profile = url.pathname.match(/^\/api\/customers\/([^/]+)\/profile$/);
  if (request.method === "GET" && profile) {
    const customerId = decodeURIComponent(profile[1]);
    const assignedIds = await auth.getAssignedCustomers(managerId);
    if (!assignedIds.includes(customerId)) return json(response, 403, { error: "无权访问该客户" }, origin);
    const customer = customerById(customerId);
    if (!customer) return json(response, 404, { error: "客户不存在" }, origin);
    // M4: 合并已确认洞察的 tags（派生数据）到客户画像；附加 tasks（供画像「近期任务」展示）
    const confirmedTags = await store.getConfirmedTagsForCustomer(customerId);
    const seedTags = Array.isArray(customer.tags) ? customer.tags : [];
    const mergedTags = Array.from(new Set([...seedTags, ...confirmedTags]));
    // tasks 每项显式标注优先级（priority 取自 customer_tasks.json，缺省兜底 0）
    const tasks = (await store.getTasksForCustomer(customerId)).map((t) => ({
      ...t,
      priority: typeof t.priority === "number" ? t.priority : 0,
    }));
    // 最新一条客户洞察全文（按创建时间倒序，无洞察为 null）
    const latestInsight = await store.getLatestInsightForCustomer(customerId);
    return json(response, 200, { ...customer, tasks, tags: mergedTags, latestInsight }, origin);
  }

  // 客户级会话摘要（客户经理专属）
  const summaryMatch = url.pathname.match(/^\/api\/customers\/([^/]+)\/summary$/);
  if (request.method === "GET" && summaryMatch) {
    const customerId = decodeURIComponent(summaryMatch[1]);
    const assignedIds = await auth.getAssignedCustomers(managerId);
    if (!assignedIds.includes(customerId)) return json(response, 403, { error: "无权访问该客户" }, origin);
    const customer = customerById(customerId);
    if (!customer) return json(response, 404, { error: "客户不存在" }, origin);
    return json(response, 200, await store.getCustomerSummary(customerId), origin);
  }

  if (request.method === "PUT" && summaryMatch) {
    const customerId = decodeURIComponent(summaryMatch[1]);
    const assignedIds = await auth.getAssignedCustomers(managerId);
    if (!assignedIds.includes(customerId)) return json(response, 403, { error: "无权编辑该客户" }, origin);
    const customer = customerById(customerId);
    if (!customer) return json(response, 404, { error: "客户不存在" }, origin);
    const body = await readBody(request);
    if (typeof body.raw !== "string") return json(response, 400, { error: "raw 必须为字符串" }, origin);
    // 可选数组字段：非数组忽略，数组则仅保留字符串元素
    const pickStrings = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === "string") : []);
    const summary = await store.saveCustomerSummary({
      customerId,
      raw: body.raw,
      preferences: pickStrings(body.preferences),
      adoptedPlans: pickStrings(body.adoptedPlans),
      concerns: pickStrings(body.concerns),
      opportunities: pickStrings(body.opportunities),
    });
    return json(response, 200, summary, origin);
  }

  // 客户任务（M3.1）
  const tasksMatch = url.pathname.match(/^\/api\/customers\/([^/]+)\/tasks$/);
  if (request.method === "GET" && tasksMatch) {
    const customerId = decodeURIComponent(tasksMatch[1]);
    const assignedIds = await auth.getAssignedCustomers(managerId);
    if (!assignedIds.includes(customerId)) return json(response, 403, { error: "无权访问该客户" }, origin);
    const tasks = await store.getTasksForCustomer(customerId);
    return json(response, 200, tasks, origin);
  }

  const taskUpdateMatch = url.pathname.match(/^\/api\/customers\/([^/]+)\/tasks\/([^/]+)$/);
  if (request.method === "PUT" && taskUpdateMatch) {
    const customerId = decodeURIComponent(taskUpdateMatch[1]);
    const taskId = decodeURIComponent(taskUpdateMatch[2]);
    const assignedIds = await auth.getAssignedCustomers(managerId);
    if (!assignedIds.includes(customerId)) return json(response, 403, { error: "无权访问该客户" }, origin);
    const body = await readBody(request);
    const updated = await store.updateTaskForCustomer(customerId, taskId, body);
    return updated ? json(response, 200, updated, origin) : json(response, 404, { error: "任务不存在" }, origin);
  }

  return false;
}