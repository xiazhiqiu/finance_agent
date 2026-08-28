import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateCustomer } from "./strategies.mjs";

const sourceDir = path.dirname(fileURLToPath(import.meta.url));
const seedPath = path.resolve(sourceDir, "../data/seed.json");
const runtimeDir = process.env.FINANCE_RUNTIME_DIR || path.resolve(sourceDir, "../../.runtime/data");
const knowledgePath = path.join(runtimeDir, "knowledge.json");
const snapshotsPath = path.join(runtimeDir, "snapshots.json");
const usersPath = path.join(runtimeDir, "users.json");
const sessionsPath = path.join(runtimeDir, "sessions.json");
const assignmentsPath = path.join(runtimeDir, "customer_assignments.json");
const planSessionsPath = path.join(runtimeDir, "plan_sessions.json");
const customerTasksPath = path.join(runtimeDir, "customer_tasks.json");
const insightsPath = path.join(runtimeDir, "insights.json");
const pendingKnowledgePath = path.join(runtimeDir, "pending-knowledge.json");
const caseStorePath = path.join(runtimeDir, "case-store.json");
const batchJobsPath = path.join(runtimeDir, "batch_jobs.json");
const profileHashesPath = path.join(runtimeDir, "customer_profile_hashes.json");
const customerSummariesPath = path.join(runtimeDir, "customer_summaries.json");
const marketBriefPath = path.join(runtimeDir, "market_brief.json");

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

// 按文件路径串行化写任务：同一文件同时只有一个写任务在途，
// 避免并发 writeFile 的 O_TRUNC 截断 + 分块写入交错，把两个写入结果混拼成损坏文件。
const writeQueues = new Map();
function queued(file, task) {
  const prev = writeQueues.get(file) ?? Promise.resolve();
  const next = prev.then(task, task);
  writeQueues.set(file, next.then(() => {}, () => {}));
  return next;
}

// 原子写：先写同目录临时文件再 rename 替换（同一文件系统内原子），
// 即使进程中途崩溃也不会留下半截 JSON，损坏的文件永远是完整的旧版本。
async function writeJson(file, value) {
  return queued(file, async () => {
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(tmp, file);
  });
}

// 读-改-写原语：在 per-file 队列内整体串行执行（read → mutate → 原子写），
// 防止并发 saveSnapshot/deleteSnapshots 基于同一旧快照互相覆盖丢失更新。
// mutate 返回 { value: 待写回的新数组, result: 返回给调用方的结果 }。
async function updateJson(file, fallback, mutate) {
  return queued(file, async () => {
    const all = await readJson(file, fallback);
    const { value, result } = await mutate(all);
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(tmp, file);
    return result;
  });
}

export const seed = JSON.parse(await readFile(seedPath, "utf8"));

export { snapshotsPath };

// 新增客户（保持 seed.customers 原引用语义）
export function addCustomer(customer) {
  seed.customers.push(customer);
}

// 删除客户（从 seed.customers 中移除，返回是否删除成功）
export function removeCustomer(customerId) {
  const idx = seed.customers.findIndex((c) => c.customerId === customerId);
  if (idx >= 0) {
    seed.customers.splice(idx, 1);
    return true;
  }
  return false;
}

export async function getKnowledge(managerId) {
  const all = await readJson(knowledgePath, {});
  return all[managerId] ?? "### 话术模板\n\n### 产品优先度\n\n### 风格偏好\n\n### 合规经验\n\n### 跟进策略\n";
}

export async function saveKnowledge(managerId, content) {
  const all = await readJson(knowledgePath, {});
  all[managerId] = content;
  await writeJson(knowledgePath, all);
}

// 快照按 planId 幂等：同一 planId 已落盘时覆盖更新旧快照字段，不重复追加记录
export async function saveSnapshot(snapshot) {
  return updateJson(snapshotsPath, [], (all) => {
    const existingIndex = all.findIndex((item) => item.planId === snapshot.planId);
    if (existingIndex >= 0) {
      // 幂等更新：同一 planId 重存时覆盖旧快照字段，保留原 id/createdAt
      const existing = all[existingIndex];
      const record = {
        ...existing,
        ...snapshot,
        id: existing.id,
        createdAt: existing.createdAt,
        updatedAt: new Date().toISOString(),
      };
      all[existingIndex] = record;
      return { value: all, result: record };
    }
    const record = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), ...snapshot };
    all.push(record);
    return { value: all, result: record };
  });
}

export async function listSnapshots(planId) {
  const all = await readJson(snapshotsPath, []);
  return all.filter((item) => item.planId === planId);
}

// 删除指定客户的所有方案快照
export async function deleteSnapshotsByCustomerId(customerId) {
  return updateJson(snapshotsPath, [], (all) => {
    const filtered = all.filter((item) => item.customerId !== customerId);
    if (filtered.length === all.length) return { value: all, result: false };
    return { value: filtered, result: true };
  });
}

// 删除指定 planId 集合的所有方案快照
export async function deleteSnapshotsByPlanIds(planIds) {
  return updateJson(snapshotsPath, [], (all) => {
    const set = new Set(planIds);
    const filtered = all.filter((item) => !set.has(item.planId));
    if (filtered.length === all.length) return { value: all, result: false };
    return { value: filtered, result: true };
  });
}

// ========== 方案会话持久化 ==========
// plan_sessions.json 结构: { sessions: PlanSession[] }
// PlanSession: { sessionId, customerId, managerId, title, createdAt, updatedAt, plans, selectedPlanId, adoptedPlanId, lastInstruction, complianceReport }

async function readPlanSessions() {
  const data = await readJson(planSessionsPath, { sessions: [] });
  if (!data || !Array.isArray(data.sessions)) return [];
  return data.sessions;
}

async function writePlanSessions(sessions) {
  await writeJson(planSessionsPath, { sessions });
}

// 列出某客户的所有方案会话(按 updatedAt 降序)
export async function listPlanSessions(customerId) {
  const sessions = await readPlanSessions();
  return sessions
    .filter((s) => s.customerId === customerId)
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

// 获取单个会话
export async function getPlanSession(sessionId) {
  const sessions = await readPlanSessions();
  return sessions.find((s) => s.sessionId === sessionId) || null;
}

// 会话标题去重：同一客户下若标题已存在，自动追加 (2)(3)... 保证标题唯一。
// excludeSessionId 用于更新场景，排除会话自身。
export function uniqueSessionTitle(sessions, customerId, title, excludeSessionId = "") {
  const used = new Set(
    sessions
      .filter((s) => s.customerId === customerId && s.sessionId !== excludeSessionId)
      .map((s) => s.title),
  );
  if (!used.has(title)) return title;
  let i = 2;
  while (used.has(`${title} (${i})`)) i += 1;
  return `${title} (${i})`;
}

// 新建会话
export async function createPlanSession({ customerId, managerId, title }) {
  const sessions = await readPlanSessions();
  const now = new Date().toISOString();
  const sessionId = `ses_${crypto.randomUUID().slice(0, 8)}`;
  const session = {
    sessionId,
    customerId,
    managerId,
    sessionKey: `agent:${process.env.FINANCE_AGENT_ID || "wealth-advisor"}:finance:direct:${managerId}-${customerId}-${sessionId}`,
    title: uniqueSessionTitle(
      sessions,
      customerId,
      title || `${now.slice(0, 10)} 对话`,
    ),
    createdAt: now,
    updatedAt: now,
    plans: [],
    selectedPlanId: "",
    adoptedPlanId: "",
    lastInstruction: "",
    complianceReport: null,
  };
  sessions.push(session);
  await writePlanSessions(sessions);
  return session;
}

// 更新会话(部分字段)
export async function updatePlanSession(sessionId, patch) {
  const sessions = await readPlanSessions();
  const idx = sessions.findIndex((s) => s.sessionId === sessionId);
  if (idx === -1) return null;
  const nextPatch = { ...patch };
  if (nextPatch.title !== undefined) {
    nextPatch.title = uniqueSessionTitle(
      sessions,
      sessions[idx].customerId,
      nextPatch.title,
      sessionId,
    );
  }
  sessions[idx] = {
    ...sessions[idx],
    ...nextPatch,
    sessionId,           // 防止改 id
    updatedAt: new Date().toISOString(),
  };
  await writePlanSessions(sessions);
  return sessions[idx];
}

// 删除会话：级联删除该会话的方案快照（按 planId 关联），返回被删除的会话
// （供上层获取 sessionKey 后继续清理 gateway 侧的对话历史目录）
export async function deletePlanSession(sessionId) {
  const sessions = await readPlanSessions();
  const idx = sessions.findIndex((s) => s.sessionId === sessionId);
  if (idx === -1) return null;
  const [deleted] = sessions.splice(idx, 1);
  await writePlanSessions(sessions);
  const planIds = (deleted.plans ?? []).map((p) => p.planId).filter(Boolean);
  if (planIds.length > 0) {
    try {
      await deleteSnapshotsByPlanIds(planIds);
    } catch (error) {
      // 快照为可重建的关联数据，清理失败不阻塞会话删除；
      // 否则快照文件损坏会导致接口报错，而会话已删除，造成前端误报"操作未完成"
      console.warn(`[store] 删除会话 ${sessionId} 时清理快照失败（忽略继续）:`, error?.message ?? error);
    }
  }
  return deleted;
}

// 删除指定客户的所有方案会话(级联删除用)
export async function deletePlanSessionsByCustomerId(customerId) {
  const sessions = await readPlanSessions();
  const filtered = sessions.filter((s) => s.customerId !== customerId);
  if (filtered.length !== sessions.length) {
    await writePlanSessions(filtered);
  }
}

function usersFallback() {
  const users = {};
  for (const user of seed.users || []) {
    users[user.managerId] = { ...user };
  }
  return users;
}

export async function readUsers() {
  return readJson(usersPath, usersFallback());
}

export async function writeUsers(users) {
  await writeJson(usersPath, users);
}

export async function readSessions() {
  return readJson(sessionsPath, {});
}

export async function writeSessions(sessions) {
  await writeJson(sessionsPath, sessions);
}

// 反向映射: { customerId: managerId | null }
// null 表示未分配
export async function readAssignments() {
  const stored = await readJson(assignmentsPath, {});
  const seedAssignments = seed.customer_assignments || {};
  let changed = false;
  // 确保 seed 中所有客户的映射都存在于运行时数据中
  for (const [customerId, managerId] of Object.entries(seedAssignments)) {
    if (!(customerId in stored)) {
      stored[customerId] = managerId;
      changed = true;
    }
  }
  if (changed) await writeJson(assignmentsPath, stored);
  return stored;
}

export async function writeAssignments(assignments) {
  await writeJson(assignmentsPath, assignments);
}

// 根据反向映射获取某客户经理名下的客户 ID 列表
export async function getAssignedCustomerIds(managerId) {
  const assignments = await readAssignments();
  return Object.entries(assignments)
    .filter(([, mgrId]) => mgrId === managerId)
    .map(([customerId]) => customerId);
}

// 获取某客户经理名下的客户数
export async function getCustomerCount(managerId) {
  const ids = await getAssignedCustomerIds(managerId);
  return ids.length;
}

// ========== 客户任务持久化（M0/M3.1）==========
// customer_tasks.json 结构: { tasks: { customerId: Task[] } }
// Task: { taskId, customerId, strategyType, strategyName, category, status, source, priority, triggerCondition, createdAt }

async function readCustomerTasks() {
  const data = await readJson(customerTasksPath, { tasks: {} });
  return data?.tasks ?? {};
}

async function writeCustomerTasks(tasks) {
  await writeJson(customerTasksPath, { tasks });
}

// 获取某客户的所有任务
export async function getTasksForCustomer(customerId) {
  const all = await readCustomerTasks();
  return all[customerId] ?? [];
}

// 获取多个客户的任务（批量）
export async function getTasksForCustomers(customerIds) {
  const all = await readCustomerTasks();
  const result = {};
  for (const id of customerIds) {
    result[id] = all[id] ?? [];
  }
  return result;
}

// 为客户写入任务（覆盖式，用于规则层批量刷新）
export async function setTasksForCustomer(customerId, tasks) {
  const all = await readCustomerTasks();
  all[customerId] = tasks;
  await writeCustomerTasks(all);
}

// 按策略合并写入任务（Y1）：非 pending 任务保留（历史/已处理状态不丢），
// pending 任务整体由本轮 newTasks 覆盖（失效策略自动移除，同策略多条命中均保留）
export async function mergeTasksForCustomer(customerId, newTasks) {
  const all = await readCustomerTasks();
  const existing = all[customerId] ?? [];
  all[customerId] = [
    ...existing.filter((t) => t.status !== "pending"),
    ...newTasks,
  ];
  await writeCustomerTasks(all);
  return all[customerId];
}

// 追加任务（用于 LLM 洞察层 / 手动添加）
export async function addTasksForCustomer(customerId, tasks) {
  const all = await readCustomerTasks();
  all[customerId] = [...(all[customerId] ?? []), ...tasks];
  await writeCustomerTasks(all);
}

// 更新单个任务状态
export async function updateTaskForCustomer(customerId, taskId, patch) {
  const all = await readCustomerTasks();
  const tasks = all[customerId] ?? [];
  const idx = tasks.findIndex((t) => t.taskId === taskId);
  if (idx === -1) return null;
  tasks[idx] = { ...tasks[idx], ...patch };
  all[customerId] = tasks;
  await writeCustomerTasks(all);
  return tasks[idx];
}

// 删除指定客户的所有任务（级联删除用）
export async function deleteTasksByCustomerId(customerId) {
  const all = await readCustomerTasks();
  if (customerId in all) {
    delete all[customerId];
    await writeCustomerTasks(all);
  }
}

// ========== 洞察持久化（M0/M4.2）==========
// insights.json 结构: { insights: Insight[] }
// Insight: { insightId, customerId, source('llm'|'accepted'), content, tags[], status('pending'|'confirmed'|'rejected'), createdAt, confirmedAt }

async function readInsights() {
  const data = await readJson(insightsPath, { insights: [] });
  return data?.insights ?? [];
}

async function writeInsights(insights) {
  await writeJson(insightsPath, { insights });
}

// 列出洞察（可按 customerId / status 筛选）
export async function listInsights(filter = {}) {
  let insights = await readInsights();
  if (filter.customerId) insights = insights.filter((i) => i.customerId === filter.customerId);
  if (filter.status) insights = insights.filter((i) => i.status === filter.status);
  return insights.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

// 新增洞察
export async function addInsight({ customerId, content, tags = [], source = "llm" }) {
  const insights = await readInsights();
  const insight = {
    insightId: `ins_${crypto.randomUUID().slice(0, 8)}`,
    customerId,
    source,
    content,
    tags,
    status: "pending",
    createdAt: new Date().toISOString(),
    confirmedAt: null,
  };
  insights.push(insight);
  await writeInsights(insights);
  // 记录本次洞察对应的画像快照哈希（用于后续增量洞察检测）
  const customer = seed.customers.find((c) => c.customerId === customerId);
  if (customer) {
    await setProfileHash(customerId, computeProfileHash(customer));
  }
  return insight;
}

// 确认洞察 → 写入客户 tags[]（派生数据）
export async function confirmInsight(insightId) {
  const insights = await readInsights();
  const idx = insights.findIndex((i) => i.insightId === insightId);
  if (idx === -1) return null;
  insights[idx].status = "confirmed";
  insights[idx].confirmedAt = new Date().toISOString();
  await writeInsights(insights);
  return insights[idx];
}

// 驳回洞察
export async function rejectInsight(insightId) {
  const insights = await readInsights();
  const idx = insights.findIndex((i) => i.insightId === insightId);
  if (idx === -1) return null;
  insights[idx].status = "rejected";
  await writeInsights(insights);
  return insights[idx];
}

// 获取已确认洞察的 tags（用于客户画像展示）
export async function getConfirmedTagsForCustomer(customerId) {
  const insights = await readInsights();
  return insights
    .filter((i) => i.customerId === customerId && i.status === "confirmed")
    .flatMap((i) => i.tags);
}

// 删除指定客户的所有洞察（级联删除用）
export async function deleteInsightsByCustomerId(customerId) {
  const insights = await readInsights();
  const filtered = insights.filter((i) => i.customerId !== customerId);
  if (filtered.length !== insights.length) {
    await writeInsights(filtered);
  }
}

// ========== 画像快照哈希（增量洞察检测）==========
// customer_profile_hashes.json 结构: { [customerId: string]: { hash: string, updatedAt: string } }

async function readProfileHashes() {
  const data = await readJson(profileHashesPath, {});
  return data;
}

async function writeProfileHashes(hashes) {
  await writeJson(profileHashesPath, hashes);
}

// 计算画像稳定哈希（按键排序序列化 + SHA-256）
export function computeProfileHash(customer) {
  // 对画像字段做稳定排序序列化（保证相同内容生成相同哈希）
  const sorted = Object.keys(customer).sort().reduce((obj, key) => {
    obj[key] = customer[key];
    return obj;
  }, {});
  const jsonStr = JSON.stringify(sorted);
  return createHash("sha256").update(jsonStr).digest("hex").slice(0, 16);
}

// 获取存储的画像哈希
export async function getProfileHash(customerId) {
  const hashes = await readProfileHashes();
  return hashes[customerId]?.hash ?? null;
}

// 存储画像哈希
export async function setProfileHash(customerId, hash) {
  const hashes = await readProfileHashes();
  hashes[customerId] = { hash, updatedAt: new Date().toISOString() };
  await writeProfileHashes(hashes);
}

// 判断画像是否发生了变动（无记录视为变动）
export async function hasProfileChanged(customerId, customer) {
  const stored = await getProfileHash(customerId);
  if (stored === null) return true;
  const current = computeProfileHash(customer);
  return current !== stored;
}

// 获取客户最新一条洞察的状态（pending/confirmed/rejected），无洞察返回 null
export async function getLatestInsightStatusForCustomer(customerId) {
  const insights = await readInsights();
  const customerInsights = insights.filter((i) => i.customerId === customerId);
  if (customerInsights.length === 0) return null;
  // 按创建时间降序，取最新一条
  customerInsights.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return customerInsights[0].status;
}

// 获取客户最新一条洞察全文（按创建时间倒序），无洞察返回 null
export async function getLatestInsightForCustomer(customerId) {
  const insights = await readInsights();
  const customerInsights = insights.filter((i) => i.customerId === customerId);
  if (customerInsights.length === 0) return null;
  customerInsights.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return customerInsights[0];
}

// 覆盖客户最新一条洞察的 content（insightId/createdAt 等元信息不变），无洞察返回 null
export async function updateLatestInsightContent(customerId, content) {
  const insights = await readInsights();
  const customerInsights = insights
    .map((i, idx) => ({ insight: i, idx }))
    .filter(({ insight }) => insight.customerId === customerId);
  if (customerInsights.length === 0) return null;
  // 按创建时间降序，最新一条在前
  customerInsights.sort((a, b) => new Date(b.insight.createdAt) - new Date(a.insight.createdAt));
  const target = customerInsights[0];
  insights[target.idx].content = content;
  await writeInsights(insights);
  return insights[target.idx];
}

// ========== 待确认知识持久化（M3 知识确认闭环）==========
// pending-knowledge.json 结构: { pending: PendingKnowledge[] }
// PendingKnowledge: { id, managerId, field(知识库段名), content, tags[], summary, confidence, source, status('pending'|'confirmed'|'rejected'), createdAt, confirmedAt }

async function readPendingKnowledge() {
  const data = await readJson(pendingKnowledgePath, { pending: [] });
  return data?.pending ?? [];
}

async function writePendingKnowledge(pending) {
  await writeJson(pendingKnowledgePath, { pending });
}

// 追加待确认知识（返回落库记录）
export async function addPendingKnowledge(items) {
  const pending = await readPendingKnowledge();
  const records = items.map((item) => ({
    id: `pk_${crypto.randomUUID().slice(0, 8)}`,
    managerId: item.managerId,
    field: item.field,
    content: item.content,
    tags: item.tags || [],
    summary: item.summary || "",
    confidence: item.confidence || "medium",
    source: item.source || "suggest",
    status: "pending",
    createdAt: new Date().toISOString(),
    confirmedAt: null,
  }));
  pending.push(...records);
  await writePendingKnowledge(pending);
  return records;
}

// 列出某经理的待确认知识（仅 pending 态，按时间倒序）
export async function listPendingKnowledge(managerId) {
  const pending = await readPendingKnowledge();
  return pending
    .filter((p) => p.managerId === managerId && p.status === "pending")
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

// 批量删除待确认知识（拒绝即删除，返回被删除记录的 id 列表）
export async function deletePendingKnowledge(ids) {
  const pending = await readPendingKnowledge();
  const targets = new Set(ids);
  const deletedIds = pending
    .filter((item) => targets.has(item.id))
    .map((item) => item.id);
  if (deletedIds.length === 0) return [];
  const remaining = pending.filter((item) => !targets.has(item.id));
  await writePendingKnowledge(remaining);
  return deletedIds;
}

// ========== 案例库持久化（M3，与 pi-gateway case-store.ts 共用同一 JSON 文件）==========
// case-store.json 结构: CaseRecord[]（与 pi-gateway CaseStore.save 输出一致）

// 列出某经理的所有案例（按创建时间倒序）
export async function listCases(managerId) {
  const cases = await readJson(caseStorePath, []);
  if (!Array.isArray(cases)) return [];
  return cases
    .filter((c) => c.managerId === managerId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

// 删除单个案例
export async function deleteCase(caseId) {
  const cases = await readJson(caseStorePath, []);
  if (!Array.isArray(cases)) return false;
  const idx = cases.findIndex((c) => c.caseId === caseId);
  if (idx === -1) return false;
  cases.splice(idx, 1);
  await writeJson(caseStorePath, cases);
  return true;
}

// ========== 批量任务记录（M0/M3.3）==========
// batch_jobs.json 结构: { jobs: BatchJob[] }
// BatchJob: { jobId, type('insight'|'plans'), managerId, status('running'|'completed'|'failed'), total, succeeded, failed, failures[], createdAt, completedAt }

async function readBatchJobs() {
  const data = await readJson(batchJobsPath, { jobs: [] });
  return data?.jobs ?? [];
}

async function writeBatchJobs(jobs) {
  await writeJson(batchJobsPath, { jobs });
}

// 创建批量任务记录
export async function createBatchJob({ type, managerId, total }) {
  const jobs = await readBatchJobs();
  const job = {
    jobId: `job_${crypto.randomUUID().slice(0, 8)}`,
    type,
    managerId,
    status: "running",
    total,
    succeeded: 0,
    failed: 0,
    failures: [],
    createdAt: new Date().toISOString(),
    completedAt: null,
  };
  jobs.push(job);
  await writeBatchJobs(jobs);
  return job;
}

// 更新批量任务
export async function updateBatchJob(jobId, patch) {
  const jobs = await readBatchJobs();
  const idx = jobs.findIndex((j) => j.jobId === jobId);
  if (idx === -1) return null;
  jobs[idx] = { ...jobs[idx], ...patch };
  await writeBatchJobs(jobs);
  return jobs[idx];
}

// 获取批量任务
export async function getBatchJob(jobId) {
  const jobs = await readBatchJobs();
  return jobs.find((j) => j.jobId === jobId) ?? null;
}

// 列出批量任务（按时间降序）
export async function listBatchJobs(managerId) {
  const jobs = await readBatchJobs();
  return jobs
    .filter((j) => !managerId || j.managerId === managerId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

// ========== 提醒区数据汇总（M3.5）==========

// 计算提醒区数据：待确认洞察数 / 批量方案完成进度 / 审查待处理数 / 沉睡客户唤醒建议数
export async function getReminders(managerId, assignedCustomers) {
  // 1. 待确认洞察数
  const allInsights = await readInsights();
  const assignedIds = new Set(assignedCustomers.map((c) => c.customerId));
  const insightPending = allInsights.filter(
    (i) => assignedIds.has(i.customerId) && i.status === "pending"
  ).length;

  // 2. 批量方案完成进度（取最近一次 plans 类型的 job）
  const jobs = await readBatchJobs();
  const planJobs = jobs.filter((j) => j.type === "plans" && (!managerId || j.managerId === managerId));
  let batchCompleted = "0/0";
  if (planJobs.length > 0) {
    const latest = planJobs[planJobs.length - 1];
    batchCompleted = `${latest.succeeded}/${latest.total}`;
  }

  // 3. 审查待处理数（status=failed 的批量方案 job 数 + 风控失败的客户数）
  const auditPending = jobs.filter(
    (j) => j.status === "completed" && j.failed > 0 && (!managerId || j.managerId === managerId)
  ).reduce((sum, j) => sum + j.failed, 0);

  // 4. 沉睡客户唤醒建议数（由策略层计算）
  const awakenSuggestion = assignedCustomers.filter((c) => {
    const tasks = evaluateCustomer(c);
    return tasks.some((t) => t.strategyType === "dormant");
  }).length;

  return { insightPending, batchCompleted, auditPending, awakenSuggestion };
}

// ========== 客户级会话摘要 ==========
// customer_summaries.json 结构: { summaries: { [customerId]: CustomerSummary } }
// CustomerSummary: { customerId, updatedAt, preferences[], adoptedPlans[], concerns[], opportunities[], raw }

async function readCustomerSummaries() {
  const data = await readJson(customerSummariesPath, { summaries: {} });
  return data?.summaries ?? {};
}

// 获取某客户的会话摘要（无记录返回 null）
export async function getCustomerSummary(customerId) {
  const summaries = await readCustomerSummaries();
  return summaries[customerId] ?? null;
}

// 保存客户会话摘要（按 customerId 覆盖写入，updatedAt 强制刷新）
export async function saveCustomerSummary(summary) {
  const summaries = await readCustomerSummaries();
  const record = { ...summary, updatedAt: new Date().toISOString() };
  summaries[record.customerId] = record;
  await writeJson(customerSummariesPath, { summaries });
  return record;
}

// ========== 市场简报 ==========
// market_brief.json 结构: { content: string, updatedAt: string }

// 获取市场简报内容（缺省空字符串）
export async function getMarketBrief() {
  const data = await readJson(marketBriefPath, {});
  return data?.content ?? "";
}

// 保存市场简报（content 转字符串写入并刷新 updatedAt）
export async function saveMarketBrief(content) {
  const record = { content: String(content), updatedAt: new Date().toISOString() };
  await writeJson(marketBriefPath, record);
  return record;
}
