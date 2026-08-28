/**
 * Backend HTTP 共享模块
 *
 * 供 customer-analyze.ts 与 plan-tools.ts 复用:
 * 统一从 process.env.FINANCE_API_URL / FINANCE_INTERNAL_TOKEN 读配置,
 * 鉴权通过 x-internal-token + x-manager-id 头(见 backend/src/server.mjs:243-254)。
 */

export interface BackendConfig {
	baseUrl: string;
	internalToken: string;
}

export function loadConfig(): BackendConfig {
	const baseUrl = (
		process.env.FINANCE_API_URL || "http://127.0.0.1:3001"
	).replace(/\/$/, "");
	const internalToken = process.env.FINANCE_INTERNAL_TOKEN || "finance-internal-token-fallback";
	return { baseUrl, internalToken };
}

function buildHeaders(
	internalToken: string,
	managerId: string,
): Record<string, string> {
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (internalToken && managerId) {
		headers["x-internal-token"] = internalToken;
		headers["x-manager-id"] = managerId;
	}
	return headers;
}

/**
 * 通用 HTTP 请求(仅内部使用)。GET 时 body 为 undefined。
 * backend 响应可能直接是数据对象,也可能包裹在 { data } 中,此处兼容两种形态并解包。
 */
async function request<T>(
	method: "GET" | "POST" | "PUT",
	path: string,
	managerId: string,
	body?: unknown,
	token?: string,
): Promise<T> {
	const { baseUrl, internalToken } = loadConfig();
	const headers = buildHeaders(token ?? internalToken, managerId);
	const response = await fetch(`${baseUrl}${path}`, {
		method,
		headers,
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	if (!response.ok) {
		const text = await response.text();
		throw new Error(`${method} ${path} failed (${response.status}): ${text}`);
	}
	const payload: unknown = await response.json();
	if (payload && typeof payload === "object" && "data" in payload) {
		return (payload as { data: T }).data;
	}
	return payload as T;
}

/**
 * 通用 GET。token 缺省时用 loadConfig().internalToken。
 */
export async function backendGet<T>(
	path: string,
	managerId: string,
	token?: string,
): Promise<T> {
	return request<T>("GET", path, managerId, undefined, token);
}

/**
 * 通用 POST。body 序列化为 JSON。token 缺省时用 loadConfig().internalToken。
 */
export async function backendPost<T>(
	path: string,
	managerId: string,
	body: unknown,
	token?: string,
): Promise<T> {
	return request<T>("POST", path, managerId, body, token);
}

/**
 * 通用 PUT。body 序列化为 JSON。token 缺省时用 loadConfig().internalToken。
 */
export async function backendPut<T>(
	path: string,
	managerId: string,
	body: unknown,
	token?: string,
): Promise<T> {
	return request<T>("PUT", path, managerId, body, token);
}

/**
 * 从 backend 会话中查找指定 target_plan_id 的方案（最新会话优先）。
 * 优化场景工具自身无法拿到上一轮方案对象时使用。
 */
export async function findPlanFromBackend(
	customerId: string,
	managerId: string,
	targetPlanId: string,
): Promise<unknown | null> {
	const { baseUrl, internalToken } = loadConfig();
	const headers = buildHeaders(internalToken, managerId);
	const response = await fetch(
		`${baseUrl}/api/sessions?customerId=${encodeURIComponent(customerId)}`,
		{ headers },
	);
	if (!response.ok) {
		throw new Error(`GET /api/sessions failed (${response.status})`);
	}
	const payload: unknown = await response.json();
	const sessions = (payload && typeof payload === "object" && "data" in payload
		? (payload as { data: unknown }).data
		: payload) as Array<{ plans?: Array<{ planId?: string }> }>;
	for (const session of sessions ?? []) {
		const plan = (session.plans ?? []).find((p) => p?.planId === targetPlanId);
		if (plan) return plan;
	}
	return null;
}
