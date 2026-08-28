// 提醒区路由（M3.5）
export default async function register(ctx) {
  const { request, response, url, session, origin, json, store, seed, auth } = ctx;
  const managerId = session.managerId;

  if (request.method === "GET" && url.pathname === "/api/reminders") {
    const assignedIds = await auth.getAssignedCustomers(managerId);
    const customers = seed.customers.filter((c) => assignedIds.includes(c.customerId));
    return json(response, 200, await store.getReminders(managerId, customers), origin);
  }

  return false;
}