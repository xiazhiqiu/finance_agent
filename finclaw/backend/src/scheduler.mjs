/**
 * 定时调度与批量链路编排（M3 完整版，洞察与方案生成解耦）
 *
 * 早 9 点洞察链路（时间全局配置，支持手动触发）：
 *   ① 批量洞察（规则层 Y1 全量重算 → tasks[]，LLM 层增量 → 待确认 insights[]）
 *   ② 归并当日到期未完成任务到客户粒度
 *
 * 定时链路只跑洞察两级；批量方案生成（runBatchPlansStage）与洞察解耦，
 * 仅由手动入口 triggerBatchPlans 触发，不进入定时链路。
 * 洞察面向全部客户（T2 全局），不依赖经理分配。
 */

import { evaluateCustomers } from "./strategies.mjs";
import {
  seed, getAssignedCustomerIds,
  mergeTasksForCustomer, getTasksForCustomer,
  createBatchJob, updateBatchJob, getBatchJob,
  addInsight, hasProfileChanged, getLatestInsightStatusForCustomer,
  createPlanSession, updatePlanSession,
  saveMarketBrief,
} from "./store.mjs";

// ========== 配置 ==========

const SCHEDULE_CONFIG = {
  // 定时时间：每天 09:00（cron 风格的 hour:minute）
  hour: Number(process.env.SCHEDULE_HOUR || 9),
  minute: Number(process.env.SCHEDULE_MINUTE || 0),
  // 批量方案并发数
  planConcurrency: Number(process.env.BATCH_PLAN_CONCURRENCY || 6),
  // pi-gateway 地址
  gatewayUrl: process.env.PI_GATEWAY_URL || "http://127.0.0.1:18789",
  // 内部服务令牌
  internalToken: process.env.FINANCE_INTERNAL_TOKEN || "finance-internal-token-fallback",
};

// ========== 定时器 ==========

let scheduleTimer = null;

/**
 * 启动定时调度（每天指定时间执行三级链路）
 */
export function startScheduler() {
  if (scheduleTimer) return;
  // 每分钟检查一次是否到点
  scheduleTimer = setInterval(async () => {
    const now = new Date();
    if (now.getHours() === SCHEDULE_CONFIG.hour && now.getMinutes() === SCHEDULE_CONFIG.minute) {
      console.log(`[scheduler] 定时触发早 ${SCHEDULE_CONFIG.hour} 点链路`);
      try {
        // 对所有客户经理执行（admin 视角）
        await runDailyChain("MGR_ADMIN");
      } catch (err) {
        console.error("[scheduler] 定时链路执行失败:", err.message);
      }
    }
  }, 60 * 1000);
  console.log(`[scheduler] 已启动，定时时间 ${String(SCHEDULE_CONFIG.hour).padStart(2, "0")}:${String(SCHEDULE_CONFIG.minute).padStart(2, "0")}`);
}

export function stopScheduler() {
  if (scheduleTimer) {
    clearInterval(scheduleTimer);
    scheduleTimer = null;
  }
}

// ========== 三级链路 ==========

/**
 * 执行早 9 点洞察链路
 * @param {string} managerId - 客户经理 ID（仅用于 job 记录与 LLM 调用头；洞察面向全部客户，存储按 customerId）
 * @param {object} options - 可选参数 { skipInsight }
 * @returns {{ jobs: object[], results: object }}
 */
export async function runDailyChain(managerId, options = {}) {
  const { skipInsight = false } = options;

  // T2：定时链路全局执行全部客户（不依赖经理分配；tasks/insights 存储均按 customerId，展示层才按经理过滤）
  const customers = seed.customers;

  if (customers.length === 0) {
    return { jobs: [], results: { message: "无客户" } };
  }

  console.log(`[scheduler] 开始洞察链路，共 ${customers.length} 个客户`);
  const jobs = [];

  // ① 批量洞察（规则层 Y1 全量重算 + LLM 层增量，两层解耦）
  let insightResult = null;
  if (!skipInsight) {
    insightResult = await runBatchInsightStage(customers, managerId);
    jobs.push(insightResult.job);
  }

  // ② 归并当日到期未完成任务到客户粒度
  const mergeResult = await mergePendingTasks(customers);
  console.log(`[scheduler] ② 归并完成：${mergeResult.mergedCount} 个客户有待处理任务`);

  // ③ 方案生成与洞察解耦：定时链路不触发批量方案生成（保留 triggerBatchPlans 手动入口）

  // ④ 市场简报刷新（全局共享，方案生成 context 的 marketBrief 数据源；失败不阻塞洞察链路）
  const briefResult = await refreshMarketBrief();
  console.log(`[scheduler] ④ 市场简报：${briefResult.ok ? `刷新完成（${briefResult.content?.length ?? 0} 字）` : `刷新失败（${briefResult.error}）`}`);

  return {
    jobs,
    results: {
      total: customers.length,
      insight: insightResult?.results || null,
      mergedCount: mergeResult.mergedCount,
      marketBrief: briefResult,
    },
  };
}

/**
 * ① 批量洞察阶段（规则层 + LLM 层，两层解耦）
 * - 规则层：对全部目标客户全量 evaluateCustomers → Y1 合并写 tasks[]（不参与增量过滤，零成本保证策略最新）
 * - LLM 层：调用 pi-gateway /api/insight/batch → insights[]（保留增量过滤：pending 跳过 / 画像未变跳过）
 */
async function runBatchInsightStage(customers, managerId, options = {}) {
  const { onlyChanged = true } = options;

  // 规则层：全量重算（Y1 合并写）
  const job = await createBatchJob({ type: "insight", managerId, total: customers.length });
  const insightResults = evaluateCustomers(customers);
  let succeeded = 0;
  let failed = 0;
  const failures = [];

  for (const result of insightResults) {
    try {
      await mergeTasksForCustomer(result.customerId, result.tasks);
      succeeded++;
    } catch (err) {
      failed++;
      failures.push({ customerId: result.customerId, error: err.message });
    }
  }

  // LLM 层：增量过滤（仅对"无待确认洞察且画像有变动"的客户调用，控制成本）
  const skipped = [];
  const targets = [];
  for (const customer of customers) {
    const latestStatus = await getLatestInsightStatusForCustomer(customer.customerId);
    if (latestStatus === "pending") {
      skipped.push({ customerId: customer.customerId, reason: "pending" });
      continue;
    }
    if (onlyChanged) {
      if (!(await hasProfileChanged(customer.customerId, customer))) {
        skipped.push({ customerId: customer.customerId, reason: "unchanged" });
        continue;
      }
    } else if (latestStatus === "confirmed" && !(await hasProfileChanged(customer.customerId, customer))) {
      skipped.push({ customerId: customer.customerId, reason: "unchanged" });
      continue;
    }
    targets.push(customer);
  }
  console.log(`[scheduler] ① 规则层完成 ${succeeded}/${customers.length}，LLM 目标 ${targets.length} 个客户（跳过 ${skipped.length} 个）`);

  try {
    const customerIds = targets.map((c) => c.customerId);
    const llmResult = await callGatewayInsight(customerIds, managerId);
    console.log(`[scheduler] ① LLM 洞察完成：成功 ${llmResult.succeeded}，失败 ${llmResult.failed}`);
  } catch (err) {
    console.warn(`[scheduler] ① LLM 洞察失败（不影响规则层）:`, err.message);
  }

  await updateBatchJob(job.jobId, {
    status: "completed",
    succeeded,
    failed,
    failures,
    completedAt: new Date().toISOString(),
  });

  console.log(`[scheduler] ① 批量洞察完成：成功 ${succeeded}，失败 ${failed}，跳过 ${skipped.length}`);

  return {
    job: await getBatchJob(job.jobId),
    results: { total: customers.length, succeeded, failed, failures, skipped },
  };
}

/**
 * ② 归并当日到期未完成任务到客户粒度
 * 统计每个客户的 pending 任务数，用于决定是否需要生成方案
 */
async function mergePendingTasks(customers) {
  let mergedCount = 0;
  for (const customer of customers) {
    const tasks = await getTasksForCustomer(customer.customerId);
    const pendingTasks = tasks.filter((t) => t.status === "pending");
    if (pendingTasks.length > 0) {
      mergedCount++;
    }
  }
  return { mergedCount };
}

/**
 * ③ 批量方案生成阶段
 *
 * 批量仅作「并发调度」，方案生成与会话管理全部复用现有逻辑：
 *  - 会话：逐客户 createPlanSession 预开会话，取得 backend PlanSession 的 sessionId/sessionKey
 *    （与前端惰性创建一致），再由 gateway 在对应正式 AgentSession 内 runPrompt（复用稳定前缀注入与
 *    generate_plan 工具），会话历史由 SDK 自然写入 .pi/sessions/。
 *  - 方案生成：指令复用前端现有「请为该客户生成一套营销方案」，不自造提示词；生成内核复用
 *    generate_plan 工具既有提示词与流程，强制合规审查。
 *  - 落库：成功后 updatePlanSession 写入 plan_sessions（与前端路径一致）。
 * 单客户失败隔离，独立记录可重试；实时更新 job 进度。
 */
async function runBatchPlansStage(customers, managerId) {
  const job = await createBatchJob({ type: "plans", managerId, total: customers.length });
  console.log(`[scheduler] ③ 开始批量方案生成，共 ${customers.length} 个客户`);

  const concurrency = SCHEDULE_CONFIG.planConcurrency;
  let succeeded = 0;
  let failed = 0;
  const failures = [];

  // 初始方案生成指令：复用前端现有指令，不自造提示词
  const instruction = "请为该客户生成一套营销方案";

  // Phase A：逐客户预开会话，取得 sessionId/sessionKey
  const items = [];
  for (const customer of customers) {
    try {
      const session = await createPlanSession({
        customerId: customer.customerId,
        managerId,
        title: `${customer.name || customer.customerId} ${new Date().toISOString().slice(0, 10)} 营销方案`,
      });
      items.push({
        customerId: customer.customerId,
        sessionId: session.sessionId,
        sessionKey: session.sessionKey,
        managerId,
        instruction,
      });
    } catch (err) {
      failed++;
      failures.push({ customerId: customer.customerId, error: `预开会话失败: ${err.message}` });
    }
  }

  // Phase B：分批并发调用 gateway 会话内生成，成功落 plan_sessions
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    let results;
    try {
      results = await callGatewayBatchPlan(batch, managerId);
    } catch (err) {
      for (const item of batch) {
        failed++;
        failures.push({ customerId: item.customerId, sessionId: item.sessionId, error: err.message });
      }
      await updateBatchJob(job.jobId, { succeeded, failed });
      continue;
    }
    if (!Array.isArray(results)) results = [];

    // 按 sessionKey 对齐结果，单条失败不牵连其它
    for (const item of batch) {
      const out = results.find((r) => r && r.sessionKey === item.sessionKey);
      if (out && out.result) {
        try {
          await updatePlanSession(item.sessionId, {
            plans: out.result.plans ?? [],
            complianceReport: out.result.complianceReport ?? null,
          });
          succeeded++;
        } catch (err) {
          failed++;
          failures.push({ customerId: item.customerId, sessionId: item.sessionId, error: `落库失败: ${err.message}` });
        }
      } else {
        failed++;
        failures.push({ customerId: item.customerId, sessionId: item.sessionId, error: out?.error || "会话内生成失败" });
      }
    }
    await updateBatchJob(job.jobId, { succeeded, failed });
  }

  await updateBatchJob(job.jobId, {
    status: "completed",
    succeeded,
    failed,
    failures,
    completedAt: new Date().toISOString(),
  });

  console.log(`[scheduler] ③ 批量方案完成：成功 ${succeeded}，失败 ${failed}`);

  return {
    job: await getBatchJob(job.jobId),
    results: { total: customers.length, succeeded, failed, failures },
  };
}

// ========== pi-gateway 调用封装 ==========

/**
 * 调用 pi-gateway /api/insight/batch 批量 LLM 洞察
 */
async function callGatewayInsight(customerIds, managerId) {
  const url = `${SCHEDULE_CONFIG.gatewayUrl}/api/insight/batch`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-internal-token": SCHEDULE_CONFIG.internalToken,
      "x-manager-id": managerId,
    },
    body: JSON.stringify({ customerIds, managerId }),
  });

  if (!resp.ok) {
    throw new Error(`pi-gateway /api/insight/batch 返回 ${resp.status}: ${await resp.text()}`);
  }

  const payload = await resp.json();
  return payload.data || payload;
}

/**
 * 调用 pi-gateway /api/sessions/batch-plan 批量会话内方案生成
 * @param {Array<{ sessionKey, customerId, managerId, instruction }>} items
 * @returns {Promise<Array<{ sessionKey, result?, error? }>>}
 */
async function callGatewayBatchPlan(items, managerId) {
  const url = `${SCHEDULE_CONFIG.gatewayUrl}/api/sessions/batch-plan`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-internal-token": SCHEDULE_CONFIG.internalToken,
      "x-manager-id": managerId,
    },
    body: JSON.stringify({ items }),
  });

  if (!resp.ok) {
    throw new Error(`pi-gateway /api/sessions/batch-plan 返回 ${resp.status}: ${await resp.text()}`);
  }

  const payload = await resp.json();
  if (payload.error) {
    throw new Error(payload.error);
  }
  return payload.data || payload;
}

/**
 * 调用 pi-gateway /api/market-brief/generate 生成市场简报（全局共享）
 * @returns {Promise<{ content: string }>}
 */
async function callGatewayMarketBrief() {
  const url = `${SCHEDULE_CONFIG.gatewayUrl}/api/market-brief/generate`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-internal-token": SCHEDULE_CONFIG.internalToken,
    },
    body: JSON.stringify({}),
  });

  if (!resp.ok) {
    throw new Error(`pi-gateway /api/market-brief/generate 返回 ${resp.status}: ${await resp.text()}`);
  }

  const payload = await resp.json();
  return payload.data || payload;
}

/**
 * 刷新市场简报：调用 pi-gateway 生成 → 校验非空 → 写入 market_brief.json。
 * 全局共享数据，供方案生成 context 的 marketBrief 字段消费。
 * @returns {{ ok: boolean, content?: string, error?: string }}
 */
export async function refreshMarketBrief() {
  try {
    const result = await callGatewayMarketBrief();
    const content = result?.content;
    if (typeof content !== "string" || content.trim() === "") {
      throw new Error("市场简报生成结果为空");
    }
    await saveMarketBrief(content);
    console.log(`[scheduler] 市场简报刷新完成（${content.length} 字）`);
    return { ok: true, content };
  } catch (err) {
    console.error("[scheduler] 市场简报刷新失败:", err.message);
    return { ok: false, error: err.message };
  }
}

// ========== 手动触发入口 ==========

/**
 * 手动触发批量洞察（规则层 + LLM 层）
 * @param {string} managerId
 * @param {object} options - { customerIds?: string[], onlyChanged?: boolean }
 */
export async function triggerBatchInsight(managerId, options = {}) {
  const { customerIds, onlyChanged = true } = options;
  const assignedIds = await getAssignedCustomerIds(managerId);
  const targetIds = Array.isArray(customerIds) && customerIds.length > 0 ? customerIds : assignedIds;
  const customers = seed.customers.filter((c) => targetIds.includes(c.customerId));

  if (customers.length === 0) {
    return { jobs: [], results: { message: "名下无客户" } };
  }

  const insightResult = await runBatchInsightStage(customers, managerId, { onlyChanged });
  return {
    job: insightResult.job,
    results: insightResult.results,
  };
}

/**
 * 手动触发批量方案生成
 * @param {string} managerId
 * @param {string[]} customerIds - 指定客户列表（可选，默认全部名下客户）
 */
export async function triggerBatchPlans(managerId, customerIds) {
  const assignedIds = await getAssignedCustomerIds(managerId);
  const targetIds = customerIds?.length > 0 ? customerIds : assignedIds;
  const customers = seed.customers.filter((c) => targetIds.includes(c.customerId));

  if (customers.length === 0) {
    return { job: null, results: { message: "无目标客户" } };
  }

  const plansResult = await runBatchPlansStage(customers, managerId);
  return {
    job: plansResult.job,
    results: plansResult.results,
  };
}

export { SCHEDULE_CONFIG };
