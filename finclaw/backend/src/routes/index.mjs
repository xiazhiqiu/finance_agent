import registerAuth from "./auth.routes.mjs";
import registerAdmin from "./admin.routes.mjs";
import registerCustomers from "./customers.routes.mjs";
import registerProducts from "./products.routes.mjs";
import registerKnowledge from "./knowledge.routes.mjs";
import registerPlans from "./plans.routes.mjs";
import registerSessions from "./sessions.routes.mjs";
import registerBatch from "./batch.routes.mjs";
import registerInsights from "./insights.routes.mjs";
import registerReminders from "./reminders.routes.mjs";
import registerMarket from "./market.routes.mjs";
import registerCaseStore from "./case-store.routes.mjs";

// 按相位（public/admin/manager）依次调用各领域 register。
// 每个 register(ctx) 返回 Promise<boolean>：命中并响应返回 true，未命中返回 false。
export async function registerAll(ctx, requestContext) {
  const { phase } = requestContext;
  const deps = { ...ctx, ...requestContext };

  const handlers = {
    public: [registerAuth],
    admin: [registerAdmin],
    manager: [
      registerAuth, registerCustomers, registerProducts, registerKnowledge,
      registerPlans, registerSessions, registerBatch, registerInsights, registerReminders,
      registerMarket, registerCaseStore,
    ],
  };

  for (const register of handlers[phase] || []) {
    if (await register(deps)) return true;
  }
  return false;
}