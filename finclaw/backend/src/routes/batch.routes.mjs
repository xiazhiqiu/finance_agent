// 批量任务路由（M0/M3.3）
export default async function register(ctx) {
  const { request, response, url, session, origin, json, readBody, store, SCHEDULE } = ctx;
  const managerId = session.managerId;

  if (request.method === "POST" && url.pathname === "/api/batch/insight") {
    const body = await readBody(request);
    const result = await SCHEDULE.triggerBatchInsight(managerId, {
      customerIds: body.customerIds,
      onlyChanged: body.onlyChanged !== undefined ? !!body.onlyChanged : true,
    });
    return json(response, 200, result, origin);
  }

  if (request.method === "POST" && url.pathname === "/api/batch/plans") {
    const body = await readBody(request);
    const result = await SCHEDULE.triggerBatchPlans(managerId, body.customerIds);
    return json(response, 200, result, origin);
  }

  if (request.method === "GET" && url.pathname === "/api/batch/jobs") {
    return json(response, 200, await store.listBatchJobs(managerId), origin);
  }

  const batchJobMatch = url.pathname.match(/^\/api\/batch\/jobs\/([^/]+)$/);
  if (request.method === "GET" && batchJobMatch) {
    const job = await store.getBatchJob(decodeURIComponent(batchJobMatch[1]));
    return job ? json(response, 200, job, origin) : json(response, 404, { error: "批量任务不存在" }, origin);
  }

  return false;
}