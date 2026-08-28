import bcrypt from "bcryptjs";

// 管理员路由（requireAdmin 已在 server.mjs 完成，此处仅处理业务路由）
export default async function register(ctx) {
  const { request, response, url, origin, json, readBody, store, seed } = ctx;
  const customerById = (id) => seed.customers.find((item) => item.customerId === id);

  // 列出所有客户经理（含名下客户数）
  if (request.method === "GET" && url.pathname === "/api/admin/managers") {
    const users = await store.readUsers();
    const managers = [];
    for (const user of Object.values(users)) {
      if (user.role === "manager") {
        managers.push({
          managerId: user.managerId,
          username: user.username,
          name: user.name,
          customerCount: await store.getCustomerCount(user.managerId),
        });
      }
    }
    return json(response, 200, managers, origin);
  }

  // 新增客户经理
  if (request.method === "POST" && url.pathname === "/api/admin/managers") {
    const body = await readBody(request);
    if (!body.username || !body.name) return json(response, 400, { error: "用户名和姓名为必填" }, origin);
    const users = await store.readUsers();
    if (Object.values(users).some((u) => u.username === body.username)) {
      return json(response, 409, { error: "用户名已存在" }, origin);
    }
    const newId = `MGR_${String(Object.keys(users).length + 1).padStart(3, "0")}`;
    users[newId] = {
      managerId: newId,
      username: body.username,
      password: bcrypt.hashSync("123456", 10),
      name: body.name,
      role: "manager",
      avatar: "",
    };
    await store.writeUsers(users);
    return json(response, 201, { managerId: newId, username: body.username, name: body.name }, origin);
  }

  // 编辑客户经理
  const editManager = url.pathname.match(/^\/api\/admin\/managers\/([^/]+)$/);
  if (request.method === "PUT" && editManager) {
    const managerId = decodeURIComponent(editManager[1]);
    const body = await readBody(request);
    const users = await store.readUsers();
    if (!users[managerId]) return json(response, 404, { error: "客户经理不存在" }, origin);
    if (users[managerId].role !== "manager") return json(response, 400, { error: "只能编辑客户经理" }, origin);
    if (body.username) {
      if (Object.values(users).some((u) => u.username === body.username && u.managerId !== managerId)) {
        return json(response, 409, { error: "用户名已存在" }, origin);
      }
      users[managerId].username = body.username;
    }
    if (body.name) users[managerId].name = body.name;
    await store.writeUsers(users);
    return json(response, 200, { success: true }, origin);
  }

  // 删除客户经理
  if (request.method === "DELETE" && editManager) {
    const managerId = decodeURIComponent(editManager[1]);
    // 超级管理员保护
    if (managerId === "MGR_ADMIN") return json(response, 403, { error: "超级管理员不可删除" }, origin);
    const users = await store.readUsers();
    if (!users[managerId]) return json(response, 404, { error: "客户经理不存在" }, origin);
    if (users[managerId].role !== "manager") return json(response, 400, { error: "只能删除客户经理" }, origin);
    const count = await store.getCustomerCount(managerId);
    if (count > 0) return json(response, 400, { error: `该客户经理名下还有 ${count} 个客户，请先转移所有客户` }, origin);
    delete users[managerId];
    await store.writeUsers(users);
    return json(response, 200, { success: true }, origin);
  }

  // 列出所有客户（含分配状态）
  if (request.method === "GET" && url.pathname === "/api/admin/customers") {
    const assignments = await store.readAssignments();
    const users = await store.readUsers();
    const customers = seed.customers.map((c) => {
      const assignedManagerId = assignments[c.customerId] || null;
      const manager = assignedManagerId ? users[assignedManagerId] : null;
      return {
        ...c,
        assignedManagerId: assignedManagerId || null,
        assignedManagerName: manager ? manager.name : null,
      };
    });
    return json(response, 200, customers, origin);
  }

  // 新增客户
  if (request.method === "POST" && url.pathname === "/api/admin/customers") {
    const body = await readBody(request);
    if (!body.name) return json(response, 400, { error: "客户姓名为必填" }, origin);
    const newId = `CUST_${String(seed.customers.length + 1).padStart(3, "0")}`;
    const newCustomer = {
      customerId: newId,
      name: body.name,
      segment: "",
      occupation: "",
      riskTolerance: "",
      aum: 0,
      aumStructure: {},
      upcomingMaturities: [],
      recentTransactions: "",
      lastContact: null,
      preferences: [],
      lifeCycleStage: "",
      riskAssessmentDate: "",
    };
    store.addCustomer(newCustomer);
    return json(response, 201, newCustomer, origin);
  }

  // 编辑客户姓名
  const editCustomer = url.pathname.match(/^\/api\/admin\/customers\/([^/]+)$/);
  if (request.method === "PUT" && editCustomer) {
    const customerId = decodeURIComponent(editCustomer[1]);
    const body = await readBody(request);
    const customer = customerById(customerId);
    if (!customer) return json(response, 404, { error: "客户不存在" }, origin);
    if (body.name) customer.name = body.name;
    return json(response, 200, { success: true }, origin);
  }

  // 删除客户（含方案快照）
  if (request.method === "DELETE" && editCustomer) {
    const customerId = decodeURIComponent(editCustomer[1]);
    const customer = customerById(customerId);
    if (!customer) return json(response, 404, { error: "客户不存在" }, origin);
    // 删除客户（从 seed 中移除）
    store.removeCustomer(customerId);
    // 删除映射关系
    const assignments = await store.readAssignments();
    delete assignments[customerId];
    await store.writeAssignments(assignments);
    // 删除方案快照
    await store.deleteSnapshotsByCustomerId(customerId);
    // 级联删除方案会话
    await store.deletePlanSessionsByCustomerId(customerId);
    // 级联删除任务与洞察
    await store.deleteTasksByCustomerId(customerId);
    await store.deleteInsightsByCustomerId(customerId);
    return json(response, 200, { success: true }, origin);
  }

  // 分配客户经理
  const assignCustomer = url.pathname.match(/^\/api\/admin\/customers\/([^/]+)\/assign$/);
  if (request.method === "PUT" && assignCustomer) {
    const customerId = decodeURIComponent(assignCustomer[1]);
    const body = await readBody(request);
    const customer = customerById(customerId);
    if (!customer) return json(response, 404, { error: "客户不存在" }, origin);
    const newManagerId = body.managerId || null;
    if (newManagerId) {
      const users = await store.readUsers();
      const manager = users[newManagerId];
      if (!manager || manager.role !== "manager") return json(response, 400, { error: "无效的客户经理" }, origin);
    }
    const assignments = await store.readAssignments();
    const oldManagerId = assignments[customerId] || null;
    // 如果转移客户，删除旧客户经理的方案快照和方案会话
    if (oldManagerId && oldManagerId !== newManagerId) {
      await store.deleteSnapshotsByCustomerId(customerId);
      await store.deletePlanSessionsByCustomerId(customerId);
    }
    assignments[customerId] = newManagerId;
    await store.writeAssignments(assignments);
    return json(response, 200, { success: true }, origin);
  }

  return false;
}