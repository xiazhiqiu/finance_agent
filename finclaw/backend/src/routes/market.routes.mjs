// 市场简报路由（客户经理专属）
import { refreshMarketBrief } from "../scheduler.mjs";

export default async function register(ctx) {
  const { request, response, url, session, origin, json, readBody, store } = ctx;

  // 手动刷新市场简报（调 pi-gateway 生成后写回 market_brief.json）
  if (url.pathname === "/api/market/brief/refresh" && request.method === "POST") {
    const result = await refreshMarketBrief();
    return json(response, result.ok ? 200 : 500, result, origin);
  }

  if (url.pathname === "/api/market/brief") {
    if (request.method === "GET") {
      return json(response, 200, { content: await store.getMarketBrief() }, origin);
    }
    if (request.method === "PUT") {
      const body = await readBody(request);
      if (typeof body.content !== "string") return json(response, 400, { error: "content 必须为字符串" }, origin);
      await store.saveMarketBrief(body.content);
      return json(response, 200, { content: body.content }, origin);
    }
  }

  return false;
}
