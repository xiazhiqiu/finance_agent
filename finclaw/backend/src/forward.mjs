const GATEWAY_URL = (process.env.PI_GATEWAY_URL || "http://127.0.0.1:18789").replace(/\/$/, "");
const INTERNAL_TOKEN = process.env.FINANCE_INTERNAL_TOKEN || "finance-internal-token-fallback";

/**
 * 转发请求到 pi-gateway（共享逻辑，供 /api/insights/extract 与 /api/knowledge/suggest 使用）
 * @param {string} path - gateway 路径（如 /api/insight/extract）
 * @param {object} body - 请求体（含 customerId / managerId / plan）
 * @param {string} managerId - 用于 x-manager-id 请求头
 * @returns {object} gwPayload.data || gwPayload
 */
export async function forwardGateway(path, body, managerId) {
  const resp = await fetch(`${GATEWAY_URL}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-internal-token": INTERNAL_TOKEN,
      "x-manager-id": managerId,
    },
    body: JSON.stringify(body),
  });
  const gwPayload = await resp.json();
  if (!resp.ok || gwPayload.error) {
    const err = new Error(gwPayload.error || `pi-gateway 返回 ${resp.status}`);
    err.status = 502;
    throw err;
  }
  return gwPayload.data || gwPayload;
}