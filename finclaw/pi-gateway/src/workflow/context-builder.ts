/**
 * 上下文组装单一出口(ContextBuilder)
 *
 * 对应 context-memory-design.md 第 4 节的 resolveScope/fetch/project/serialize
 * 四步组装流程,本文件承载其中的 project(白名单投影)与 serialize(紧凑序列化
 * + 预算裁剪);fetch 在 backend-client.ts(按 scope 拉取)。
 */

import type {
	CustomerProfile,
	CustomerTask,
	LeafPlanContext,
	WorkflowContext,
} from "./types.ts";

/**
 * plan scope 白名单投影:从(可能部分缺省的)完整上下文裁出叶子所需字段。
 * customer 剔除 tasks(已由 strategies 承载,避免重复注入)后原样保留;
 * products 每项 pick 13 个生成参考字段,剔除 minAmount/availableQuota/
 * onSale/campaigns 等配额与在售字段;strategies(客户命中任务)原样透传,
 * 供 LLM 生成方案时参考。
 */
export function projectPlanContext(ctx: Partial<WorkflowContext>): LeafPlanContext {
	if (!ctx.customer) {
		throw new Error("plan scope 缺少客户画像");
	}
	// B4: 剔除 customer.tasks——任务已由 strategies 承载,重复注入浪费 token
	const customer = { ...(ctx.customer as CustomerProfile & { tasks?: unknown }) };
	delete customer.tasks;
	const products = (ctx.products ?? []).map((p) => ({
		productId: p.productId,
		name: p.name,
		category: p.category,
		subCategory: p.subCategory,
		riskLevel: p.riskLevel,
		tenor: p.tenor,
		expectedReturn: p.expectedReturn,
		description: p.description,
		benchmark: p.benchmark,
		returns: p.returns,
		marketTags: p.marketTags,
		scriptTemplate: p.scriptTemplate,
		highlights: p.highlights,
	}));
	const leaf: LeafPlanContext = {
		customer,
		products,
		personalKnowledge: ctx.personalKnowledge ?? "",
	};
	if (Array.isArray(ctx.strategies) && ctx.strategies.length > 0) {
		leaf.strategies = ctx.strategies as CustomerTask[];
	}
	// marketBrief 仅在非空字符串时保留
	if (typeof ctx.marketBrief === "string" && ctx.marketBrief !== "") {
		leaf.marketBrief = ctx.marketBrief;
	}
	return leaf;
}

/** products 表格字段顺序（表头即字段名,键名只出现一次） */
const PRODUCT_TABLE_FIELDS = [
	"productId",
	"name",
	"category",
	"subCategory",
	"riskLevel",
	"tenor",
	"expectedReturn",
	"description",
	"benchmark",
	"returns",
	"marketTags",
	"highlights",
	"scriptTemplate",
] as const;

/** B2: 长文本截断（描述/话术参考字段） */
function truncate(s: string, n: number): string {
	return s.length <= n ? s : s.slice(0, n) + "…";
}

/** 单元格清洗:替换 | 与换行,防止破坏表格列分隔 */
function cell(v: unknown): string {
	return String(v ?? "").replace(/[|\n]/g, " ").trim();
}

/**
 * B1+B2: products 扁平表格化序列化。
 * 每行一个产品,表头行声明字段顺序,| 为列分隔;
 * description 截断 80 字符、scriptTemplate 截断 60 字符,其余字段原样。
 */
function serializeProductsTable(products: LeafPlanContext["products"]): string {
	if (!products || products.length === 0) return "[]";
	const rows = products.map((p) =>
		[
			cell(p.productId),
			cell(p.name),
			cell(p.category),
			cell(p.subCategory),
			cell(p.riskLevel),
			cell(p.tenor),
			cell(p.expectedReturn),
			truncate(cell(p.description), 80),
			cell(p.benchmark),
			cell(
				p.returns
					? Object.entries(p.returns).map(([k, v]) => `${k}:${v}`).join(",")
					: "",
			),
			cell(Array.isArray(p.marketTags) ? p.marketTags.join(",") : p.marketTags),
			cell(Array.isArray(p.highlights) ? p.highlights.join(",") : p.highlights),
			truncate(cell(p.scriptTemplate), 60),
		].join("|"),
	);
	return `products 候选表(每行一个产品,字段顺序同表头,| 为列分隔):\n${PRODUCT_TABLE_FIELDS.join("|")}\n${rows.join("\n")}`;
}

/**
 * serialize 步骤:紧凑 JSON.stringify(无缩进)+ token 预算控制。
 * products 经 serializeProductsTable 表格化(B1+B2)后作为字符串字段注入;
 * 估算 token = Math.ceil(json.length / 4);超预算时按顺序裁剪:
 * personalKnowledge 截半 → marketBrief 截半 → personalKnowledge 置空串。
 * 先克隆对象再裁剪,不改入参。
 */
export function serializeLeafContext(
	leaf: LeafPlanContext,
	budgetTokens = 4000,
): string {
	const trimmed: LeafPlanContext = { ...leaf };
	let json = JSON.stringify({ ...trimmed, products: serializeProductsTable(trimmed.products) });
	let est = Math.ceil(json.length / 4);
	if (est > budgetTokens) {
		trimmed.personalKnowledge = trimmed.personalKnowledge.slice(
			0,
			Math.ceil(trimmed.personalKnowledge.length / 2),
		);
		json = JSON.stringify({ ...trimmed, products: serializeProductsTable(trimmed.products) });
		est = Math.ceil(json.length / 4);
	}
	if (est > budgetTokens && typeof trimmed.marketBrief === "string") {
		trimmed.marketBrief = trimmed.marketBrief.slice(
			0,
			Math.ceil(trimmed.marketBrief.length / 2),
		);
		json = JSON.stringify({ ...trimmed, products: serializeProductsTable(trimmed.products) });
		est = Math.ceil(json.length / 4);
	}
	if (est > budgetTokens) {
		trimmed.personalKnowledge = "";
		json = JSON.stringify({ ...trimmed, products: serializeProductsTable(trimmed.products) });
		est = Math.ceil(json.length / 4);
	}
	console.log(`[context-builder] scope=plan estTokens=${est}`);
	return json;
}

/** chat scope 稳定前缀中的客户白名单字段 */
export interface ChatPrefixCustomer {
	customerId: string;
	name: string;
	segment?: string;
	riskTolerance?: string;
	aum?: number;
	lifeCycleStage?: string;
	preferences?: string[];
}

export interface ChatStablePrefixInput {
	customerId?: string;
	managerId?: string;
	customer?: ChatPrefixCustomer | null;
	summary?: string | null;
	knowledge?: string | null;
}

function firstNChars(s: string, n: number): string {
	return s.length <= n ? s : s.slice(0, n);
}

/**
 * 构建主对话稳定前缀(注入系统提示尾部),布局对前缀缓存友好:
 * 键固定顺序 managerId/customer/summary/knowledge,值稳定不随轮次变化。
 */
export function buildChatStablePrefix(input: ChatStablePrefixInput): string {
	// customer 已是 ChatPrefixCustomer 白名单形状，直接序列化即可
	const line = JSON.stringify({
		managerId: input.managerId ?? null,
		customer: input.customer ?? null,
		summary: input.summary || "暂无",
		knowledge: firstNChars(input.knowledge ?? "", 300),
	});
	return [
		"## 会话业务上下文",
		line,
		"以上为该会话的长期业务背景，回答时可参考，无需向用户复述。",
		"当前会话绑定的客户 ID 为 customer.customerId，调用任何需要 customerId 的工具时必须使用此值，不得自行编造。",
	].join("\n");
}
