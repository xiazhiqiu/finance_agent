import type {
  CustomerProfile, CustomerSummary, MarketingPlan, PersonalKnowledge,
  UserInfo, ManagerInfo, AdminCustomer, LoginRequest, ResetPasswordRequest,
  PublicResetPasswordRequest, CreateManagerRequest, EditManagerRequest,
  CreateCustomerRequest, EditCustomerNameRequest, AssignCustomerRequest,
  EditCustomerProfileRequest, PlanSession, ComplianceReport,
  MarketingStrategy, MarketingTask, Insight, BatchJob, Reminders,
  BatchInsightResult, BatchInsightRequest, KnowledgeCandidate,
  KnowledgeSuggestion, PendingKnowledgeItem, CaseItem, CaseStoreItem,
} from "./types.ts";

function unwrap<T>(value: T | { data: T }): T {
  return value && typeof value === "object" && "data" in value ? value.data : value;
}

export class FinanceApi {
  constructor(private readonly baseUrl: string) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
      ...init,
      credentials: "include",
      headers: { "Content-Type": "application/json", ...init?.headers },
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`业务服务请求失败 (${response.status})${detail ? `：${detail}` : ""}`);
    }
    return unwrap((await response.json()) as T | { data: T });
  }

  // ========== 客户经理 API ==========

  listCustomers(filter?: {
    taskType?: string;
    taskStatus?: string;
    hasInsight?: boolean;
  }) {
    const params = new URLSearchParams();
    if (filter?.taskType) params.set("taskType", filter.taskType);
    if (filter?.taskStatus) params.set("taskStatus", filter.taskStatus);
    if (filter?.hasInsight) params.set("hasInsight", "1");
    const query = params.toString();
    return this.request<CustomerSummary[]>(`/api/customers${query ? `?${query}` : ""}`);
  }

  getCustomer(customerId: string) {
    return this.request<CustomerProfile>(
      `/api/customers/${encodeURIComponent(customerId)}/profile`,
    );
  }

  editCustomerProfile(customerId: string, data: EditCustomerProfileRequest) {
    return this.request<CustomerProfile>(
      `/api/customers/${encodeURIComponent(customerId)}`,
      { method: "PUT", body: JSON.stringify(data) },
    );
  }

  getKnowledge() {
    return this.request<PersonalKnowledge>("/api/knowledge");
  }

  /** 产品全字段详情（前端点击产品详情用） */
  getProduct(productId: string) {
    return this.request<Record<string, unknown>>(
      `/api/products/${encodeURIComponent(productId)}`,
    );
  }

  saveKnowledge(knowledge: PersonalKnowledge) {
    return this.request<{ success: boolean; content: string }>("/api/knowledge/save", {
      method: "POST",
      body: JSON.stringify(knowledge),
    });
  }

  saveSnapshot(plan: MarketingPlan, meta?: {
    managerId?: string;
    generation?: "initial" | "optimize";
    instruction?: string | null;
  }) {
    return this.request<{ id?: string; success?: boolean }>("/api/plans/snapshots", {
      method: "POST",
      body: JSON.stringify({
        planId: plan.planId,
        customerId: plan.customerId,
        managerId: meta?.managerId,
        title: plan.title,
        score: plan.score,
        tags: plan.tags,
        diagnosis: plan.diagnosis,
        allocation: plan.allocation,
        products: plan.products,
        scripts: plan.scripts,
        markdown: plan.markdown,
        generation: meta?.generation ?? "initial",
        instruction: meta?.instruction ?? null,
        adopted: false,
      }),
    });
  }

  // ========== 方案会话 API ==========

  listSessions(customerId: string) {
    return this.request<PlanSession[]>(
      `/api/sessions?customerId=${encodeURIComponent(customerId)}`,
    );
  }

  getSession(sessionId: string) {
    return this.request<PlanSession>(`/api/sessions/${encodeURIComponent(sessionId)}`);
  }

  createSession(customerId: string, title?: string) {
    return this.request<PlanSession>("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ customerId, title }),
    });
  }

  updateSession(sessionId: string, patch: {
    plans?: MarketingPlan[];
    selectedPlanId?: string;
    adoptedPlanId?: string;
    lastInstruction?: string;
    complianceReport?: ComplianceReport | null;
    title?: string;
  }) {
    return this.request<PlanSession>(`/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: "PUT",
      body: JSON.stringify(patch),
    });
  }

  deleteSession(sessionId: string) {
    return this.request<{ success: boolean; sessionKey?: string | null }>(
      `/api/sessions/${encodeURIComponent(sessionId)}`,
      { method: "DELETE" },
    );
  }

  // ========== 认证 API ==========

  login(data: LoginRequest) {
    return this.request<UserInfo>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  logout() {
    return this.request<{ success: boolean }>("/api/auth/logout", {
      method: "POST",
    });
  }

  getMe() {
    return this.request<UserInfo>("/api/auth/me");
  }

  resetPassword(data: ResetPasswordRequest) {
    return this.request<{ success: boolean }>("/api/auth/reset-password", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  resetPasswordPublic(data: PublicResetPasswordRequest) {
    return this.request<{ success: boolean }>("/api/auth/reset-password-public", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  // ========== 管理员 API ==========

  listManagers() {
    return this.request<ManagerInfo[]>("/api/admin/managers");
  }

  createManager(data: CreateManagerRequest) {
    return this.request<ManagerInfo>("/api/admin/managers", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  editManager(managerId: string, data: EditManagerRequest) {
    return this.request<{ success: boolean }>(
      `/api/admin/managers/${encodeURIComponent(managerId)}`,
      { method: "PUT", body: JSON.stringify(data) },
    );
  }

  deleteManager(managerId: string) {
    return this.request<{ success: boolean }>(
      `/api/admin/managers/${encodeURIComponent(managerId)}`,
      { method: "DELETE" },
    );
  }

  listAllCustomers() {
    return this.request<AdminCustomer[]>("/api/admin/customers");
  }

  createCustomer(data: CreateCustomerRequest) {
    return this.request<AdminCustomer>("/api/admin/customers", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  editCustomerName(customerId: string, data: EditCustomerNameRequest) {
    return this.request<{ success: boolean }>(
      `/api/admin/customers/${encodeURIComponent(customerId)}`,
      { method: "PUT", body: JSON.stringify(data) },
    );
  }

  deleteCustomer(customerId: string) {
    return this.request<{ success: boolean }>(
      `/api/admin/customers/${encodeURIComponent(customerId)}`,
      { method: "DELETE" },
    );
  }

  assignCustomer(customerId: string, data: AssignCustomerRequest) {
    return this.request<{ success: boolean }>(
      `/api/admin/customers/${encodeURIComponent(customerId)}/assign`,
      { method: "PUT", body: JSON.stringify(data) },
    );
  }

  // ========== 营销策略 / 客户任务 API（M0/M3） ==========

  listStrategies() {
    return this.request<MarketingStrategy[]>("/api/strategies");
  }

  listCustomerTasks(customerId: string) {
    return this.request<MarketingTask[]>(
      `/api/customers/${encodeURIComponent(customerId)}/tasks`,
    );
  }

  updateCustomerTask(
    customerId: string,
    taskId: string,
    patch: { status?: MarketingTask["status"] },
  ) {
    return this.request<MarketingTask>(
      `/api/customers/${encodeURIComponent(customerId)}/tasks/${encodeURIComponent(taskId)}`,
      { method: "PUT", body: JSON.stringify(patch) },
    );
  }

  // ========== 批量任务 API（M0/M3） ==========

  triggerBatchInsight(req?: BatchInsightRequest) {
    return this.request<BatchInsightResult>("/api/batch/insight", {
      method: "POST",
      body: JSON.stringify(req ?? {}),
    });
  }

  triggerBatchPlans(customerIds: string[]) {
    return this.request<BatchInsightResult>("/api/batch/plans", {
      method: "POST",
      body: JSON.stringify({ customerIds }),
    });
  }

  listBatchJobs() {
    return this.request<BatchJob[]>("/api/batch/jobs");
  }

  getBatchJob(jobId: string) {
    return this.request<BatchJob>(`/api/batch/jobs/${encodeURIComponent(jobId)}`);
  }

  // ========== 提醒区 API（M3） ==========

  getReminders() {
    return this.request<Reminders>("/api/reminders");
  }

  // ========== 洞察 API（M4） ==========

  listInsights(filter?: { customerId?: string; status?: Insight["status"] }) {
    const params = new URLSearchParams();
    if (filter?.customerId) params.set("customerId", filter.customerId);
    if (filter?.status) params.set("status", filter.status);
    const query = params.toString();
    return this.request<Insight[]>(`/api/insights${query ? `?${query}` : ""}`);
  }

  addInsight(data: {
    customerId: string;
    content: string;
    tags?: string[];
    source?: Insight["source"];
  }) {
    return this.request<Insight>("/api/insights", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  confirmInsight(insightId: string) {
    return this.request<Insight>(
      `/api/insights/${encodeURIComponent(insightId)}/confirm`,
      { method: "PUT" },
    );
  }

  rejectInsight(insightId: string) {
    return this.request<Insight>(
      `/api/insights/${encodeURIComponent(insightId)}/reject`,
      { method: "PUT" },
    );
  }

  /** M4.2 · 知识库沉淀建议（LLM 提取，结果写入待确认区，经理在知识库页确认） */
  suggestKnowledge(data: { customerId: string; plan: MarketingPlan }) {
    return this.request<KnowledgeSuggestion>("/api/knowledge/suggest", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  /** M3 · 待确认知识列表（PRD §3.5.1） */
  listPendingKnowledge() {
    return this.request<PendingKnowledgeItem[]>("/api/knowledge/pending");
  }

  /** M3 · 批量确认待确认知识（并入知识库对应段） */
  confirmPendingKnowledge(ids: string[]) {
    return this.request<{ confirmed: string[] }>("/api/knowledge/confirm-pending", {
      method: "POST",
      body: JSON.stringify({ ids }),
    });
  }

  /** M3 · 批量拒绝待确认知识 */
  rejectPendingKnowledge(ids: string[]) {
    return this.request<{ rejected: string[] }>("/api/knowledge/reject-pending", {
      method: "POST",
      body: JSON.stringify({ ids }),
    });
  }

  /** M5.2 · 记忆沉淀候选分析（从最近对话提炼候选知识项） */
  suggestCandidates(data: { customerId: string; sessionKey: string }) {
    return this.request<KnowledgeCandidate[]>("/api/knowledge/candidates", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  /** M5.2 · 批量应用用户确认的候选知识 */
  applyKnowledge(items: Array<{ category: string; content: string }>) {
    return this.request<{ success: boolean; applied: number }>("/api/knowledge/apply", {
      method: "POST",
      body: JSON.stringify({ items }),
    });
  }

  /** M0 · 案例检索（基于客户画像相似度，返回 Top-N 相似成交案例） */
  searchCases(data: { customerId: string; limit?: number }) {
    return this.request<{ cases: CaseItem[]; totalFound: number; strategy: string }>("/api/case-store/search", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  /** M3 · 案例库列表（当前经理所有案例） */
  listCases() {
    return this.request<CaseStoreItem[]>("/api/case-store");
  }

  /** M3 · 删除单个案例 */
  deleteCase(caseId: string) {
    return this.request<{ success: boolean }>(`/api/case-store/${encodeURIComponent(caseId)}`, {
      method: "DELETE",
    });
  }
}