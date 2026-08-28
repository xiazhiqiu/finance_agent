import http from "node:http";
import * as store from "./store.mjs";
import * as auth from "./auth.mjs";
import { corsHeaders, json, readBody } from "./helpers.mjs";
import { forwardGateway } from "./forward.mjs";
import { triggerBatchInsight, triggerBatchPlans, startScheduler } from "./scheduler.mjs";
import { STRATEGIES } from "./strategies.mjs";
import { auditPlans } from "./compliance.mjs";
import { composeKnowledgeMarkdown, parseKnowledgeMarkdown } from "./knowledge.mjs";
import { registerAll } from "./routes/index.mjs";

const port = Number(process.env.FINANCE_BACKEND_PORT || 3001);

// 组装层：注入各领域路由共享的依赖
const ctx = {
  json,
  readBody,
  corsHeaders,
  store,
  auth,
  SCHEDULE: { triggerBatchInsight, triggerBatchPlans },
  forwardGateway,
  STRATEGIES,
  seed: store.seed,
  compliance: { auditPlans },
  knowledge: { composeKnowledgeMarkdown, parseKnowledgeMarkdown },
};

const server = http.createServer(async (request, response) => {
  const origin = request.headers.origin || "";
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      ...corsHeaders(origin),
      "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
      "access-control-allow-headers": "content-type",
    });
    return response.end();
  }
  const url = new URL(request.url, `http://${request.headers.host}`);
  try {
    // ========== 公开路由（无需登录） ==========
    if (request.method === "GET" && url.pathname === "/health") return json(response, 200, { ok: true, service: "finance-backend" }, origin);

    // 认证公开路由：login / logout / reset-password-public
    if (await registerAll(ctx, { request, response, url, session: null, origin, phase: "public" })) return;

    // ========== 管理员专属 API（需 requireAdmin） ==========
    const adminMatch = url.pathname.match(/^\/api\/admin\//);
    if (adminMatch) {
      const adminSession = await auth.requireAdmin(request, response, origin);
      if (!adminSession) return;

      if (await registerAll(ctx, { request, response, url, session: adminSession, origin, phase: "admin" })) return;
      return json(response, 404, { error: "管理员接口不存在" }, origin);
    }

    // ========== 需要登录的路由（非 admin） ==========
    // 内部服务令牌：pi-gateway 的 bash 工具调用 context.mjs 时使用
    const internalToken = process.env.FINANCE_INTERNAL_TOKEN || "finance-internal-token-fallback";
    let session;
    if (internalToken && request.headers["x-internal-token"] === internalToken) {
      const serviceManagerId = String(request.headers["x-manager-id"] || "");
      if (!serviceManagerId) {
        return json(response, 400, { error: "内部调用缺少 X-Manager-Id" }, origin);
      }
      session = { managerId: serviceManagerId, role: "manager" };
    } else {
      session = await auth.requireAuth(request, response, origin);
      if (!session) return;
    }
    const { role } = session;

    // 管理员无权访问客户经理功能
    if (role === "admin") {
      return json(response, 403, { error: "管理员无权访问此功能，请使用管理后台" }, origin);
    }

    if (await registerAll(ctx, { request, response, url, session, origin, phase: "manager" })) return;
    return json(response, 404, { error: "接口不存在" }, origin);
  } catch (error) {
    console.error(error);
    return json(response, 500, { error: error instanceof Error ? error.message : String(error) }, origin);
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`finance backend listening on http://127.0.0.1:${port}`);
  startScheduler();
});