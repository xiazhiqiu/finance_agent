import "./styles.css";
import { AdvisorGateway } from "./advisor-gateway.ts";
import { ChatSessionState } from "./chat-state.ts";
import { FinanceApi } from "./api.ts";
import { renderMarkdown } from "./markdown.ts";
import { stripJsonFence } from "./result-parser.ts";
import { escapeHtml, money, parseDiagnosisSections } from "./render-utils.ts";
import { defaultSessionTitle, isOldPlaceholderTitle } from "./session-title.ts";
import type {
  AppConfig, CustomerProfile, CustomerSummary, MarketingPlan, PersonalKnowledge,
  UserInfo, ManagerInfo, AdminCustomer, EditCustomerProfileRequest,
  PlanSession, ComplianceReport, Reminders, Insight, GenerateResult,
  ChatMessage, GatewaySessionSummary, PendingKnowledgeItem, CaseItem, CaseStoreItem,
} from "./types.ts";
import { safeKey } from "./safe-key.ts";

/** 工具内部名 → 前端展示名（只渲染顶层动作，不下发详细参数） */
function toolDisplayName(name: string): string {
  const table: Record<string, string> = {
    generate_plan: "方案生成",
    optimize_plan: "方案优化",
    customer_analyze: "客户分析",
    product_query: "产品查询",
    case_search: "案例检索",
  };
  return table[name] || name;
}

/** 知识类别 → 中文标签（记忆沉淀候选弹窗） */
const CATEGORY_LABELS: Record<string, string> = {
  talkTemplates: "话术模板",
  productPriority: "产品优先度",
  stylePreference: "风格偏好",
  combinationStrategy: "组合策略",
  compliance: "合规经验",
  objectionHandling: "异议处理",
  followUp: "跟进策略",
  customerInsight: "客户洞察",
};

/** 知识库段字段 → 中文标签（待确认沉淀区） */
const FIELD_LABELS: Record<string, string> = {
  talkTemplates: "话术模板",
  productPriority: "产品优先度",
  stylePreference: "风格偏好",
  compliance: "合规经验",
  followUp: "跟进策略",
};

const root = document.querySelector<HTMLDivElement>("#app");
if (!root) throw new Error("Missing #app root");

const configKey = "openclaw.finance-advisor.config";
/** 会话界面状态持久化键：刷新后恢复上次浏览的客户与会话 */
const uiStateKey = "openclaw.finance-advisor.ui-state";
const defaultConfig: AppConfig = {
  apiUrl: import.meta.env.VITE_FINANCE_API_URL || "http://127.0.0.1:3001",
  gatewayUrl: import.meta.env.VITE_GATEWAY_URL || "http://127.0.0.1:18789",
  gatewayToken: import.meta.env.VITE_GATEWAY_TOKEN || "",
  agentId: import.meta.env.VITE_AGENT_ID || "wealth-advisor",
  managerId: import.meta.env.VITE_MANAGER_ID || "manager-local",
};

function loadConfig(): AppConfig {
  try { return { ...defaultConfig, ...JSON.parse(localStorage.getItem(configKey) ?? "{}") } as AppConfig; }
  catch { return defaultConfig; }
}

interface UiState { customerId?: string; sessionId?: string; }

function loadUiState(): UiState {
  try { return JSON.parse(localStorage.getItem(uiStateKey) ?? "{}") as UiState; }
  catch { return {}; }
}

function saveUiState(state: UiState) {
  try { localStorage.setItem(uiStateKey, JSON.stringify(state)); }
  catch { /* localStorage 不可用时静默忽略 */ }
}

class FinanceAdvisorApp {
  private config = loadConfig();
  private api = new FinanceApi(this.config.apiUrl);
  private gateway: AdvisorGateway | null = null;
  private connected = false;
  private connectionDetail = "正在连接";
  private customers: CustomerSummary[] = [];
  private customer: CustomerProfile | null = null;
  private plans: MarketingPlan[] = [];
  private selectedPlanId = "";
  private adoptedPlanId = ""; // 已成交方案的 planId（独立于 selectedPlanId）
  private historyExpanded = false; // 推荐方案界面"历史方案"折叠区是否展开
  private customerPaneCollapsed = false;
  private compareIds = new Set<string>();
  private loadingCustomers = true;
  // 会话持久化状态
  private currentSessionId = "";
  private sessionHistory: PlanSession[] = [];
  private loadingSession = false;
  // 历史会话标题行内编辑状态
  private editingSessionId = "";
  private editingTitleValue = "";
  // M5 · 对话界面统一改造：右栏聊天状态
  private chat = new ChatSessionState();
  /** 会话刚加载/切换后贴底锁定：每次 DOM 重建都滚到底；用户上滚查看历史时由滚动监听解锁 */
  private chatPinBottom = true;
  private chatListScrollBound = false;
  private currentSessionKey = "";
  private gatewaySessions: GatewaySessionSummary[] = [];
  private error = "";
  private toast = "";
  private modal: "compare" | "knowledge" | "case-store" | "settings" | "edit-profile" | "admin-create-manager" | "admin-edit-manager" | "admin-create-customer" | "admin-edit-customer" | "plan-detail" | "product-detail" | "send-confirm" | null = null;
  private detailPlanId = "";
  /** 产品详情弹窗（getProduct 全字段） */
  private productDetail: Record<string, unknown> | null = null;
  private productDetailLoading = false;
  private productDetailError = "";
  /** 产品详情弹窗的来源弹窗（关闭时恢复,如方案详情） */
  private productDetailFrom: string | null = null;
  private sendConfirmChannel: "wecom" | "sms" = "wecom";
  private sendConfirmText = "";
  private knowledge: PersonalKnowledge = { talkTemplates: "", productPriority: "", stylePreference: "", compliance: "", followUp: "" };
  // M3 · 待确认沉淀（方案采纳提取，经理确认后并入知识库）
  private pendingKnowledge: PendingKnowledgeItem[] = [];
  private pendingSelectedIds = new Set<string>();
  private pendingActioning = false;
  // M3 · 案例库弹窗
  private caseStore: CaseStoreItem[] = [];
  private caseStoreLoading = false;
  private caseStoreQuery = "";
  private caseStoreQualFilter: "all" | "high" | "medium" = "all";
  private toastTimer: number | null = null;
  private user: UserInfo | null = null;
  private checkingAuth = true;
  private loginUsername = "";
  private loginPassword = "";
  private loginError = "";
  private loginLoading = false;
  private loginMode: "login" | "reset" = "login";
  private resetUsername = "";
  private resetOldPassword = "";
  private resetNewPassword = "";
  private resetMessage = "";
  private resetLoading = false;
  // Admin state
  private managers: ManagerInfo[] = [];
  private allCustomers: AdminCustomer[] = [];
  private adminTab: "managers" | "customers" = "managers";
  private adminLoading = false;
  private adminManagerSearch = "";
  private adminCustomerSearch = "";
  private composing = false;

  // M1 · 双界面工作台状态
  private activeTab: "profile" | "plans" | "sessions" = "profile";
  private plansHasNew = false;
  private reminderFilters = new Set<string>();
  private reminders: Reminders | null = null;
  private pendingInsightCustomerIds = new Set<string>();
  private pollTimer: number | null = null;
  private multiSelectMode = false;
  // 批量任务运行态（独立标志，支持两任务后台并行）：对应按钮显示转圈并置灰
  private runningInsight = false;
  private runningPlans = false;
  private selectedCustomerIds = new Set<string>();
  // M1 · 批量方案生成的未读红点（按经理 localStorage 持久化；点客户即清）
  private batchUnread = new Set<string>();
  private customerSearchValue = "";
  private agentInput = "";
  private batchModalMode: "insight" | "plans" | null = null;
  // M4 · 待确认洞察（当前客户）
  private pendingInsights: Insight[] = [];
  private insightActioning = false;
  // Edit profile state
  private editProfileData: EditCustomerProfileRequest = {};
  /** 编辑画像偏好下拉候选（seed.json 全客户偏好去重，写死在前端） */
  private static readonly PREFERENCE_OPTIONS: readonly string[] = [
    "主题投资", "低波动", "低风险", "保本", "全球配置", "养老规划", "分散配置",
    "新兴产业", "期限一年内", "期限错配", "权益投资", "汇率对冲", "流动性",
    "短线操作", "科技创新", "税务筹划", "稳健收益", "稳定现金流", "财富传承",
    "资产配置", "长期成长", "高波动", "高风险高回报",
  ];
  /** 编辑画像偏好下拉展开态 */
  private prefDropdownOpen = false;
  // Admin create/edit form state
  private adminFormName = "";
  private adminFormUsername = "";
  private adminFormManagerId = "";
  private adminFormCustomerId = "";
  private adminFormCustomerName = "";

  constructor(private readonly container: HTMLDivElement) {
    container.addEventListener("click", (event) => void this.handleClick(event));
    // 偏好交互（下拉/勾选/移除）在 mousedown 阶段阻止默认行为：避免 checkbox/按钮被聚焦后，
    // 因弹窗重建（DOM 移除）导致焦点回落到 body、窗口自动跳转到顶部
    container.addEventListener("mousedown", (event) => {
      const el = (event.target as HTMLElement).closest<HTMLElement>("[data-action]");
      if (el && ["toggle-pref-dropdown", "toggle-pref", "remove-pref"].includes(el.dataset.action || "")) {
        event.preventDefault();
      }
    });
    container.addEventListener("input", (event) => this.handleInput(event));
    container.addEventListener("keydown", (event) => this.handleKeydown(event));
    container.addEventListener("compositionstart", () => { this.composing = true; });
    container.addEventListener("compositionend", (event) => { this.composing = false; this.handleInput(event as unknown as Event); });
    container.addEventListener("focusout", (event) => this.handleFocusOut(event));
    window.addEventListener("hashchange", () => this.handleHashChange());
    this.checkAuth();
  }

  // ========== Hash 路由 ==========

  private getHash(): string {
    return window.location.hash.replace(/^#/, "") || "login";
  }

  private setHash(hash: string) {
    if (window.location.hash !== `#${hash}`) {
      window.location.hash = hash;
    }
  }

  private handleHashChange() {
    if (!this.user || this.checkingAuth) return;
    const hash = this.getHash();
    if (this.user.role === "admin" && hash !== "admin") {
      this.setHash("admin");
      this.renderAdmin();
      return;
    }
    if (this.user.role === "manager" && hash !== "dashboard") {
      this.setHash("dashboard");
      this.render();
      return;
    }
    if (hash === "admin") this.renderAdmin();
    else this.render();
  }

  // ========== 认证 ==========

  private async checkAuth() {
    this.checkingAuth = true;
    this.render();
    try {
      this.user = await this.api.getMe();
      this.checkingAuth = false;
      if (this.user.role === "admin") {
        this.setHash("admin");
        this.renderAdmin();
        void this.loadAdminData("managers");
      } else {
        this.setHash("dashboard");
        this.render();
        this.connectGateway();
        void this.loadCustomers();
        // F1 · 60s 轮询洞察数据（定时 9 点洞察结果自动上屏）
        this.startReminderPolling();
      }
    } catch {
      this.user = null;
      this.checkingAuth = false;
      this.render();
    }
  }

  private connectGateway() {
    this.gateway?.disconnect();
    this.connected = false;
    this.connectionDetail = "正在连接";
    this.gateway = new AdvisorGateway({
      url: this.config.gatewayUrl,
      token: this.config.gatewayToken,
      onStatus: (connected, detail) => {
        this.connected = connected;
        this.connectionDetail = connected ? "pi-agent 已连接" : detail || "连接已断开";
        this.renderHeader();
        this.renderPlans();
        // M1 · 连接状态影响右栏 agent 快捷指令/输入框可用性
        const agent = this.container.querySelector(".agent-pane");
        if (agent) agent.innerHTML = this.agentPaneHtml();
        // M5 · 连接后加载 pi-gateway 历史会话（用于会话卡片消息预览/条数）
        void this.loadGatewaySessions();
      },
    });
    void this.gateway.connect();
  }

  private async loadCustomers() {
    this.loadingCustomers = true;
    this.error = "";
    this.render();
    try {
      this.customers = await this.api.listCustomers();
      // 恢复上次浏览的客户；否则退化为第一个客户。会话恢复在 selectCustomer 内部处理
      const saved = this.restoreKeys();
      const savedCustomer = saved.customerId ? this.customers.find((c) => c.customerId === saved.customerId) : undefined;
      const customerId = savedCustomer ? savedCustomer.customerId : this.customers[0]?.customerId;
      if (customerId) await this.selectCustomer(customerId, saved.sessionId, !!savedCustomer);
      // M1 · 初始加载提醒区数据
      void this.loadReminders();
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.loadingCustomers = false;
      this.render();
    }
  }

  /** 将后端 PlanSession 装载为当前会话 UI 状态（含历史对话加载） */
  private applySession(session: PlanSession | null) {
    this.chatPinBottom = true;
    this.currentSessionId = session?.sessionId ?? "";
    this.currentSessionKey = session?.sessionKey ?? "";
    this.plans = session?.plans || [];
    this.selectedPlanId = session?.selectedPlanId || "";
    this.adoptedPlanId = session?.adoptedPlanId || "";
    this.historyExpanded = false;
    this.chat.messages = [];
    this.compareIds.clear();
    if (this.currentSessionKey) void this.loadSessionChat(this.currentSessionKey);
    this.persistUiState();
  }

  /** 读取上次会话界面状态（供 sessionStorage 恢复用，封装键名） */
  private restoreKeys(): UiState {
    return loadUiState();
  }

  /** 持久化当前会话界面状态（客户+会话），便于刷新后停留在原对话 */
  private persistUiState() {
    saveUiState({ customerId: this.customer?.customerId ?? "", sessionId: this.currentSessionId });
  }

  private async selectCustomer(customerId: string, restoreSessionId?: string, resumeLastSession = false) {
    this.error = "";
    // M1 · 点击客户条目即清除其批量方案未读红点
    this.clearBatchUnreadFor(customerId);
    this.selectedPlanId = "";
    this.adoptedPlanId = "";
    this.historyExpanded = false;
    this.compareIds.clear();
    this.currentSessionId = "";
    this.currentSessionKey = "";
    this.sessionHistory = [];
    this.plans = [];
    this.chat.messages = [];
    this.loadingSession = true;
    try {
      // 拉取客户最新画像
      this.customer = await this.api.getCustomer(customerId);
      // 拉取该客户的所有历史会话(按 updatedAt 降序)
      this.sessionHistory = await this.api.listSessions(customerId);
      // 恢复上次浏览的会话；否则自动加载最新会话
      const target = resumeLastSession && restoreSessionId
        ? this.sessionHistory.find((s) => s.sessionId === restoreSessionId)
        : undefined;
      if (target) {
        const session = await this.api.getSession(target.sessionId);
        this.applySession(session);
      } else if (this.sessionHistory.length > 0) {
        this.applySession(this.sessionHistory[0]);
      } else {
        this.applySession(null);
      }
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.customer = null;
    } finally {
      this.loadingSession = false;
    }
    // 仅局部刷新中栏/右栏与客户列表高亮，避免全量 render 重建客户列表导致滚动回顶部
    this.renderAfterSwitch();
    this.persistUiState();
    // M1 · 加载提醒区数据（不阻塞渲染）
    void this.loadReminders();
    // M4 · 加载该客户待确认洞察（不阻塞渲染）
    void this.loadPendingInsights();
    // M5 · 加载 pi-gateway 历史会话摘要（会话卡片消息预览/条数）
    void this.loadGatewaySessions();
  }

  // M4 · 拉取当前客户的待确认洞察
  private async loadPendingInsights() {
    if (!this.customer) { this.pendingInsights = []; return; }
    try {
      this.pendingInsights = await this.api.listInsights({
        customerId: this.customer.customerId,
        status: "pending",
      });
    } catch {
      this.pendingInsights = [];
    }
    // 仅在画像 Tab 局部刷新（不重建客户列表，避免滚动回顶部）
    if (this.activeTab === "profile") this.renderAfterSwitch();
  }

  // 切换到指定历史会话
  private async switchSession(sessionId: string) {
    if (!this.customer || sessionId === this.currentSessionId) {
      this.render();
      return;
    }
    this.loadingSession = true;
    this.render();
    try {
      // 重新拉取最新画像(需求:读取用户最新画像而不是当时的画像)
      this.customer = await this.api.getCustomer(this.customer.customerId);
      // 拉取目标会话
      const session = await this.api.getSession(sessionId);
      this.applySession(session);
      // 同步会话列表(updatedAt 顺序可能变化)
      this.sessionHistory = await this.api.listSessions(this.customer.customerId);
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.loadingSession = false;
    }
    this.render();
    void this.loadGatewaySessions();
  }

  // 开新会话:在当前客户下创建空会话,等用户发送消息时填充
  private async startNewSession() {
    if (!this.customer) return;
    this.loadingSession = true;
    this.render();
    try {
      const session = await this.api.createSession(this.customer.customerId, defaultSessionTitle(this.customer.name, new Date().toISOString()));
      this.applySession(session);
      // 重新拉取最新画像
      this.customer = await this.api.getCustomer(this.customer.customerId);
      this.sessionHistory = await this.api.listSessions(this.customer.customerId);
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.loadingSession = false;
    }
    this.render();
    void this.loadGatewaySessions();
  }

  // 持久化当前会话(plans/selectedPlanId/lastInstruction/complianceReport)
  private async persistSession(lastInstruction?: string, complianceReport?: ComplianceReport | null) {
    if (!this.currentSessionId || !this.customer) return;
    try {
      await this.api.updateSession(this.currentSessionId, {
        plans: this.plans,
        selectedPlanId: this.selectedPlanId,
        adoptedPlanId: this.adoptedPlanId || undefined,
        lastInstruction: lastInstruction ?? "",
        complianceReport: complianceReport ?? null,
      });
      // 同步本地会话列表
      this.sessionHistory = await this.api.listSessions(this.customer.customerId);
    } catch {
      // 持久化失败不阻塞主流程,只记录错误
    }
  }

  // 删除指定会话
  private async deleteSessionFromList(sessionId: string) {
    if (!this.customer) return;
    if (!confirm("确定要删除该会话吗？此操作不可撤销。")) return;
    try {
      const deleted = await this.api.deleteSession(sessionId);
      // 级联清理 pi-gateway 侧的对话历史目录（孤儿清理，失败不阻塞主流程）
      if (deleted?.sessionKey) {
        try {
          await this.gateway.deleteSession(deleted.sessionKey);
        } catch {
          // 网关清理失败仅记录，业务数据已删除
        }
      }
      this.sessionHistory = await this.api.listSessions(this.customer.customerId);
      // 若删除的是当前会话,切到最新会话
      if (sessionId === this.currentSessionId) {
        if (this.sessionHistory.length > 0) {
          const latest = this.sessionHistory[0];
          this.currentSessionId = latest.sessionId;
          this.currentSessionKey = latest.sessionKey ?? "";
          this.plans = latest.plans || [];
          this.selectedPlanId = latest.selectedPlanId || "";
          this.adoptedPlanId = latest.adoptedPlanId || "";
          this.historyExpanded = false;
          this.chat.messages = [];
          if (this.currentSessionKey) void this.loadSessionChat(this.currentSessionKey);
        } else {
          this.currentSessionId = "";
          this.currentSessionKey = "";
          this.plans = [];
          this.selectedPlanId = "";
          this.adoptedPlanId = "";
          this.historyExpanded = false;
          this.chat.messages = [];
        }
        this.persistUiState();
      }
      this.showToast("会话已删除");
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    }
    this.render();
    void this.loadGatewaySessions();
  }

  // ========== 管理员功能 ==========

  private async loadAdminData(tab?: "managers" | "customers") {
    if (tab) this.adminTab = tab;
    this.adminLoading = true;
    this.renderAdmin();
    try {
      if (this.adminTab === "managers") {
        this.managers = await this.api.listManagers();
      } else {
        this.allCustomers = await this.api.listAllCustomers();
      }
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    }
    this.adminLoading = false;
    this.renderAdmin();
  }

  private async doCreateManager() {
    if (!this.adminFormUsername.trim() || !this.adminFormName.trim()) {
      this.error = "用户名和姓名为必填";
      this.renderAdmin();
      return;
    }
    try {
      await this.api.createManager({ username: this.adminFormUsername.trim(), name: this.adminFormName.trim() });
      this.adminFormUsername = "";
      this.adminFormName = "";
      this.modal = null;
      this.showToast("客户经理已创建，初始密码 123456");
      await this.loadAdminData("managers");
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.renderAdmin();
    }
  }

  private async doEditManager() {
    try {
      await this.api.editManager(this.adminFormManagerId, {
        username: this.adminFormUsername.trim() || undefined,
        name: this.adminFormName.trim() || undefined,
      });
      this.adminFormManagerId = "";
      this.adminFormUsername = "";
      this.adminFormName = "";
      this.modal = null;
      this.showToast("客户经理已更新");
      await this.loadAdminData("managers");
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.renderAdmin();
    }
  }

  private async doDeleteManager(managerId: string) {
    if (!confirm("确定要删除该客户经理吗？")) return;
    try {
      await this.api.deleteManager(managerId);
      this.showToast("客户经理已删除");
      await this.loadAdminData("managers");
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.renderAdmin();
    }
  }

  private async doCreateCustomer() {
    if (!this.adminFormCustomerName.trim()) {
      this.error = "客户姓名为必填";
      this.renderAdmin();
      return;
    }
    try {
      await this.api.createCustomer({ name: this.adminFormCustomerName.trim() });
      this.adminFormCustomerName = "";
      this.modal = null;
      this.showToast("客户已创建");
      await this.loadAdminData("customers");
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.renderAdmin();
    }
  }

  private async doEditCustomerName() {
    try {
      await this.api.editCustomerName(this.adminFormCustomerId, { name: this.adminFormCustomerName.trim() });
      this.adminFormCustomerId = "";
      this.adminFormCustomerName = "";
      this.modal = null;
      this.showToast("客户姓名已更新");
      await this.loadAdminData("customers");
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.renderAdmin();
    }
  }

  private async doDeleteCustomer(customerId: string) {
    if (!confirm("确定要删除该客户吗？该操作将同时删除关联的方案快照。")) return;
    try {
      await this.api.deleteCustomer(customerId);
      this.showToast("客户已删除");
      await this.loadAdminData("customers");
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.renderAdmin();
    }
  }

  private async doAssignCustomer(customerId: string, managerId: string | null) {
    const old = this.allCustomers.find((c) => c.customerId === customerId);
    const oldManagerId = old?.assignedManagerId;
    if (oldManagerId && oldManagerId !== managerId) {
      if (!confirm(`该操作将删除客户经理 ${old?.assignedManagerName || oldManagerId} 为该客户生成的所有方案快照，确认继续？`)) return;
    }
    try {
      await this.api.assignCustomer(customerId, { managerId });
      this.showToast("分配成功");
      await this.loadAdminData("customers");
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.renderAdmin();
    }
  }

  // ========== 客户画像编辑 ==========

  private async openEditProfile() {
    if (!this.customer) return;
    this.editProfileData = {
      segment: this.customer.segment,
      occupation: this.customer.occupation,
      riskTolerance: this.customer.riskTolerance,
      aumStructure: this.customer.aumStructure ? { ...this.customer.aumStructure } : {},
      upcomingMaturities: this.customer.upcomingMaturities ? [...this.customer.upcomingMaturities] : [],
      recentTransactions: this.customer.recentTransactions,
      lastContact: this.customer.lastContact ? { ...this.customer.lastContact } : undefined,
      preferences: this.customer.preferences ? [...this.customer.preferences] : [],
      lifeCycleStage: this.customer.lifeCycleStage,
      riskAssessmentDate: this.customer.riskAssessmentDate,
      latestInsight: this.customer.latestInsight?.content ?? "",
    };
    this.prefDropdownOpen = false;
    this.modal = "edit-profile";
    this.renderModal();
  }

  private async doSaveProfile() {
    if (!this.customer) return;
    const d = this.editProfileData;
    try {
      // 画像编辑仅开放「偏好」与「最新客户洞察」：其余字段只读，保存时只提交这两项
      await this.api.editCustomerProfile(this.customer.customerId, {
        preferences: d.preferences || [],
        latestInsight: d.latestInsight ?? "",
      });
      this.modal = null;
      this.showToast("客户画像已保存");
      // 重新加载客户详情
      this.customer = await this.api.getCustomer(this.customer.customerId);
      this.render();
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.render();
    }
  }

  // ========== 对话发送（M5 · 统一走 pi-gateway 自由聊天） ==========

  /**
   * 发送一条消息：插入用户气泡 → 空 assistant 气泡流式接收 SSE 事件。
   * 会话在首次发送时惰性创建（backend PlanSession + 其 sessionKey 绑定 pi-gateway 对话上下文）。
   */
  private async sendMessage(text: string): Promise<void> {
    if (!this.customer) { this.error = "请先选择客户"; this.render(); return; }
    if (!this.gateway || !this.connected) { this.error = "pi-gateway 未连接"; this.render(); return; }
    if (this.chat.streaming) return;
    if (!this.customer.aum || this.customer.aum === 0) {
      this.error = "请先完善客户画像再开始对话";
      this.render();
      return;
    }
    const content = text.trim();
    if (!content) { this.error = "请输入指令"; this.render(); return; }

    // 首次发送：惰性创建会话
    if (!this.currentSessionId) {
      try {
        const session = await this.api.createSession(this.customer.customerId, defaultSessionTitle(this.customer.name, new Date().toISOString()));
        this.currentSessionId = session.sessionId;
        this.currentSessionKey = session.sessionKey ?? "";
        this.sessionHistory = await this.api.listSessions(this.customer.customerId);
      } catch (e) {
        this.error = e instanceof Error ? e.message : String(e);
        this.render();
        return;
      }
    }
    if (!this.currentSessionKey) {
      this.error = "当前会话缺少 sessionKey，请新建会话后重试";
      this.render();
      return;
    }

    // 用户气泡
    this.chat.messages.push({
      id: this.chat.nextMessageId(),
      role: "user",
      text: content,
      timestamp: new Date().toISOString(),
    });
    this.agentInput = "";
    // 空的 assistant 气泡（流式填充）
    const assistantMsg: ChatMessage = {
      id: this.chat.nextMessageId(),
      role: "assistant",
      text: "",
      streaming: true,
      timestamp: new Date().toISOString(),
    };
    this.chat.messages.push(assistantMsg);

    this.chat.streaming = true;
    this.error = "";
    // 用户主动发送新指令后始终锚定最新对话：解除此前用户上滚导致的贴底锁定，
    // 否则 renderAgentPane() 重建 .chat-list 时滚动被重置到最早历史顶部。
    this.chatPinBottom = true;
    this.renderAgentPane();
    this.scrollChatToBottom();

    let assistantText = "";
    // 流式期间暂存方案工具结果，待文字输出结束（sendChat 完成后）再渲染卡片，避免对话区布局抖动
    const pendingPlanResults: Array<{ toolName: string; generateResult: GenerateResult }> = [];
    // 流式期间暂存案例检索结果，待文字输出结束后挂到气泡（case_search 工具化后统一走此路径渲染卡片）
    let pendingCaseResults: CaseItem[] = [];
    try {
      await this.gateway.sendChat(this.currentSessionKey, content, {
        onThinking: () => {
          this.updateChatMessage(assistantMsg.id, { toolStatus: "AI 思考中…" });
        },
        onToolCall: (toolName) => {
          // 只渲染顶层动作：正在调用某工具，不下发/展示任何详细参数
          this.updateChatMessage(assistantMsg.id, { toolStatus: `正在调用「${toolDisplayName(toolName)}」…` });
        },
        onToolResult: (toolName, result) => {
          if (toolName === "generate_plan" || toolName === "optimize_plan") {
            const details = (result as { details?: { result?: unknown } } | undefined)?.details;
            const generateResult = details?.result;
            if (!this.isGenerateResult(generateResult)) return;
            // 只暂存，不在此处渲染；等文字流结束后统一挂卡片
            pendingPlanResults.push({ toolName, generateResult });
            return;
          }
          if (toolName === "case_search") {
            const details = (result as { details?: { cases?: CaseItem[] } } | undefined)?.details;
            const cases = details?.cases;
            if (Array.isArray(cases) && cases.length > 0) pendingCaseResults = cases;
          }
        },
        onMessage: (delta) => {
          if (delta && !assistantText) this.updateChatMessage(assistantMsg.id, { toolStatus: "" });
          assistantText += delta;
          this.updateChatMessage(assistantMsg.id, { text: assistantText });
        },
      }, { customerId: this.customer?.customerId, managerId: this.user?.managerId });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.error = message;
      this.updateChatMessage(assistantMsg.id, { text: assistantText || message });
    } finally {
      // 先归零 streaming，再渲染，确保这次渲染读到的是最新状态（输入框/按钮恢复可用）。
      // 之前顺序相反导致下方 updateChatMessage 的渲染发生在 streaming 仍为 true 时，
      // 非方案分支（纯问答、客户画像、产品查询等）如何结束后再无渲染，按钮卡死。
      this.chat.streaming = false;
      this.updateChatMessage(assistantMsg.id, { streaming: false, toolStatus: "" });
      // 文字输出已结束，此时渲染方案卡片（含推荐方案 Tab 同步）
      for (const p of pendingPlanResults) {
        this.handlePlanToolResult(assistantMsg.id, p.toolName, p.generateResult, content);
      }
      // 案例检索结果挂到气泡，触发相似案例卡片渲染
      if (pendingCaseResults.length > 0) {
        this.updateChatMessage(assistantMsg.id, { cases: pendingCaseResults });
      }
      // 重渲染输入栏：恢复发送按钮旋转态（streaming 复位后同步到 DOM）
      this.renderAgentPane();
      this.scrollChatToBottom();
    }
  }

  /**
   * 处理方案工具结果：渲染气泡内方案卡片，同步 this.plans 并持久化会话。
   * generate_plan 替换方案列表；optimize_plan 追加（后端已为优化方案生成唯一 planId，
   * 此处 -opt-N 后缀仅作兜底防重，正常不触发）。
   */
  private handlePlanToolResult(
    assistantMsgId: string,
    toolName: string,
    generateResult: GenerateResult,
    instruction: string,
  ) {
    const msg = this.chat.messages.find((m) => m.id === assistantMsgId);
    if (!msg) return;
    msg.plans = generateResult;
    // 方案卡片已渲染，清空"AI 正在处理…"状态
    msg.toolStatus = "";
    const isOptimize = toolName === "optimize_plan";
    if (isOptimize) {
      const optimizedPlan = generateResult.plans[0];
      if (optimizedPlan) {
        const existingIds = new Set(this.plans.map((p) => p.planId));
        if (existingIds.has(optimizedPlan.planId)) {
          let suffix = 1;
          let newId = `${optimizedPlan.planId}-opt-${suffix}`;
          while (existingIds.has(newId)) {
            suffix++;
            newId = `${optimizedPlan.planId}-opt-${suffix}`;
          }
          optimizedPlan.planId = newId;
        }
        this.plans.push(optimizedPlan);
        this.compareIds.clear();
      }
      // 优化后自动选中最新版本
      this.selectedPlanId = this.plans[this.plans.length - 1]?.planId ?? "";
    } else {
      this.plans = generateResult.plans;
      this.compareIds.clear();
      this.selectedPlanId = "";
    }
    // 持久化当前会话；优化时以用户指令作为 lastInstruction
    void this.persistSession(isOptimize ? instruction : undefined, generateResult.compliance ?? null);
    // 快照自动存档：仅本轮方案写入 snapshots.json（后端按 planId 幂等去重）。
    // 不遍历 this.plans，避免优化时把历史方案重复落盘。
    const generation = isOptimize ? "optimize" : "initial";
    for (const plan of generateResult.plans) {
      void this.api.saveSnapshot(plan, {
        managerId: this.user?.managerId,
        generation,
        instruction: isOptimize ? instruction : null,
      });
    }
    // M1 · 方案双端同步：非"推荐方案"Tab 时标记"新"
    if (this.activeTab !== "plans") this.plansHasNew = true;
    this.renderAgentPane();
    this.renderPlans();
  }

  /**
   * 经 pi-gateway 读取指定会话的对话消息并填充 messages（历史回看）。
   * 方案工具摘要文本只含 [planId] 轻量引用，完整方案从 PlanSession（this.plans）按 planId 匹配还原，
   * 不再从文本解析完整 JSON。
   */
  private async loadSessionChat(sessionKey: string) {
    if (!this.gateway || !sessionKey) { this.chat.messages = []; return; }
    try {
      const raw = await this.gateway.getSessionMessages(sessionKey);
      this.chat.messages = raw.map((m, index) => {
        const base: ChatMessage = {
          id: `h${index}`,
          role: m.role === "user" ? "user" : "assistant",
          text: m.content,
          timestamp: m.timestamp,
        };
        if (m.role !== "user" && m.plans) {
          // 后端透传方案结果（旧格式兼容），直接还原
          base.plans = m.plans;
        } else if (m.role !== "user") {
          // 新格式：从摘要文本中的 [planId] 引用解析，从 this.plans 取完整方案
          base.plans = this.plansFromSummary(m.content);
        }
        return base;
      });
    } catch {
      this.chat.messages = [];
    }
    this.renderAgentPane();
    this.scrollChatToBottom();
  }

  /** 从方案摘要文本（含 [planId] 引用）匹配出完整方案，无命中返回 undefined */
  private plansFromSummary(content: string): GenerateResult | undefined {
    const refs = content.match(/\[([a-zA-Z0-9_-]+)\]/g);
    if (!refs) return undefined;
    const ids = new Set(refs.map((r) => r.slice(1, -1)));
    const plans = this.plans.filter((p) => ids.has(p.planId));
    return plans.length ? { plans } : undefined;
  }

  /** 加载 pi-gateway 历史会话摘要（供会话卡片显示消息预览/条数） */
  private async loadGatewaySessions() {
    if (!this.gateway || !this.connected) { this.gatewaySessions = []; return; }
    try {
      this.gatewaySessions = await this.gateway.listSessions();
    } catch {
      this.gatewaySessions = [];
    }
    if (this.activeTab === "sessions") this.renderAfterSwitch();
  }

  /** 按 sessionKey 匹配 pi-gateway 会话摘要（gateway sessionId 为 safeKey） */
  private gatewaySessionFor(session: PlanSession): GatewaySessionSummary | undefined {
    const key = safeKey(session.sessionKey ?? "");
    return this.gatewaySessions.find((g) => g.sessionId === key);
  }

  private isGenerateResult(value: unknown): value is GenerateResult {
    return Boolean(
      value && typeof value === "object" && Array.isArray((value as GenerateResult).plans),
    );
  }

  private updateChatMessage(id: string, patch: Partial<ChatMessage>) {
    if (!this.chat.updateMessage(id, patch)) return;
    this.renderAgentPane();
    this.scrollChatToBottom();
  }

  // M1 · 加载提醒区数据
  private async loadReminders() {
    try {
      this.reminders = await this.api.getReminders();
      // 加载有待确认洞察的客户 ID 集合（用于提醒栏"待确认洞察"标签快捷筛选）
      const pendingInsightCustomers = await this.api.listCustomers({ hasInsight: true });
      this.pendingInsightCustomerIds = new Set(pendingInsightCustomers.map((c) => c.customerId));
      this.renderReminderBar();
    } catch (e) {
      console.error("加载提醒数据失败:", e);
    }
  }

  // F1 · 60s 轮询洞察数据：提醒区计数/客户任务数变化时局部刷新并轻提示
  private startReminderPolling() {
    if (this.pollTimer) return;
    this.pollTimer = window.setInterval(async () => {
      try {
        const reminders = await this.api.getReminders();
        const customers = await this.api.listCustomers();
        const pendingCount = (c: CustomerSummary) => c.tasks?.filter((t) => t.status === "pending" && t.strategyType !== "account_review").length ?? 0;
        const insightChanged = this.reminders?.insightPending !== reminders.insightPending;
        const taskChanged = JSON.stringify(customers.map((c) => [c.customerId, pendingCount(c)])) !==
          JSON.stringify(this.customers.map((c) => [c.customerId, pendingCount(c)]));
        this.reminders = reminders;
        this.customers = customers;
        if (insightChanged || taskChanged) {
          this.showToast("洞察数据已更新");
          this.renderReminderBar();
          const list = this.container.querySelector("#customer-list");
          if (list) list.innerHTML = this.customerListHtml(this.customerSearchValue);
        }
      } catch { /* 轮询失败静默，下轮重试 */ }
    }, 60000);
  }

  // M1 · 客户洞察（多选客户，支持仅画像变动）
  private async doBatchInsight() {
    if (this.selectedCustomerIds.size === 0) {
      this.error = "请先勾选客户";
      this.render();
      return;
    }
    if (this.runningInsight) return; // 已有洞察任务在跑，忽略重复点击
    this.error = "";
    const ids = Array.from(this.selectedCustomerIds);
    this.runningInsight = true;
    this.renderMultiSelectBar();
    this.showToast(`正在为 ${ids.length} 个客户执行洞察...`);
    try {
      const result = await this.api.triggerBatchInsight({ customerIds: ids });
      const { succeeded, failed, skipped } = result.results;
      const skippedCount = skipped?.length ?? 0;
      const pendingSkip = skipped?.filter((s) => s.reason === "pending").length ?? 0;
      let msg = `客户洞察完成：成功 ${succeeded}，失败 ${failed}`;
      if (pendingSkip > 0) msg += `，${pendingSkip} 个已有待确认洞察已跳过`;
      else if (skippedCount > 0) msg += `，${skippedCount} 个画像未变更已跳过`;
      this.showToast(msg);
      // 刷新客户列表（带最新 tasks/tags）
      this.customers = await this.api.listCustomers();
      await this.loadReminders();
      this.refreshAfterBatch();
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.refreshAfterBatch();
    } finally {
      this.runningInsight = false;
    }
  }

  // M1 · 批量方案未读红点：localStorage 读写（按经理分区）
  private batchUnreadKey() {
    const managerId = this.user?.managerId || this.config.managerId || "manager-local";
    return `batchPlanUnread:${managerId}`;
  }
  private readBatchUnread(): Set<string> {
    try {
      return new Set(JSON.parse(localStorage.getItem(this.batchUnreadKey()) ?? "[]") as string[]);
    } catch {
      return new Set();
    }
  }
  private writeBatchUnread() {
    try {
      localStorage.setItem(this.batchUnreadKey(), JSON.stringify(Array.from(this.batchUnread)));
    } catch { /* localStorage 不可用时静默忽略 */ }
  }
  // 点击客户条目后清除其未读红点
  private clearBatchUnreadFor(customerId: string) {
    this.batchUnread = this.readBatchUnread();
    if (!this.batchUnread.delete(customerId)) return;
    this.writeBatchUnread();
    this.renderCustomerList(this.customerSearchValue);
  }

  // M1 · 退出批量勾选态（清空多选标记与已勾选客户，回到普通列表）
  private exitMultiSelect() {
    this.multiSelectMode = false;
    this.selectedCustomerIds.clear();
  }

  // 批量任务完成后仅刷新左侧（移除多选条 + 重绘客户列表含红点 + 同步错误横幅），
  // 不动右侧对话/AI 栏，避免打扰正在进行的其他操作
  private refreshAfterBatch() {
    this.exitMultiSelect();
    this.renderMultiSelectBar();
    this.renderCustomerList(this.customerSearchValue);
    this.renderErrorBanner();
  }

  // 局部更新顶部的错误横幅（取代原来依赖全量 render 输出 error-banner 的方式）
  private renderErrorBanner() {
    const placeholder = this.container.querySelector(".error-banner");
    if (this.error) {
      const html = `<div class="error-banner"><strong>操作未完成</strong><span>${escapeHtml(this.error)}</span><button data-action="close-error">×</button></div>`;
      if (placeholder) placeholder.outerHTML = html;
      else {
        const bar = this.container.querySelector("#reminder-bar");
        if (bar) bar.insertAdjacentHTML("beforebegin", html);
      }
    } else if (placeholder) {
      placeholder.remove();
    }
  }

  // M1 · 批量方案生成（多选客户）
  private async doBatchPlans() {
    if (this.selectedCustomerIds.size === 0) {
      this.error = "请先勾选客户";
      this.render();
      return;
    }
    if (this.runningPlans) return; // 已有方案任务在跑，忽略重复点击
    this.error = "";
    const ids = Array.from(this.selectedCustomerIds);
    this.runningPlans = true;
    this.renderMultiSelectBar();
    this.showToast(`正在为 ${ids.length} 个客户生成方案...`);
    try {
      const result = await this.api.triggerBatchPlans(ids);
      const { succeeded, failed, failures } = result.results;
      this.showToast(`批量方案完成：成功 ${succeeded}，失败 ${failed}`);
      // 批量成功的客户标记未读红点（勾选客户 - 失败客户）
      const successIds = ids.filter((id) => !(failures ?? []).some((f) => f.customerId === id));
      if (successIds.length > 0) {
        for (const id of successIds) this.batchUnread.add(id);
        this.writeBatchUnread();
      }
      await this.loadReminders();
      // 仅刷新客户列表（含批量新方案红点），不动右侧正在进行的优化
      this.customers = await this.api.listCustomers();
      this.refreshAfterBatch();
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.refreshAfterBatch();
    } finally {
      this.runningPlans = false;
    }
  }

  private async openKnowledge() {
    try {
      this.knowledge = await this.api.getKnowledge();
      await this.loadPendingKnowledge();
      this.modal = "knowledge";
      this.renderModal();
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.render();
    }
  }

  // M3 · 拉取待确认沉淀（方案采纳提取，经理确认后并入知识库）
  private async loadPendingKnowledge() {
    try {
      this.pendingKnowledge = await this.api.listPendingKnowledge();
    } catch {
      this.pendingKnowledge = [];
    }
    // 清理已不在列表中的勾选
    const valid = new Set(this.pendingKnowledge.map((p) => p.id));
    for (const id of this.pendingSelectedIds) if (!valid.has(id)) this.pendingSelectedIds.delete(id);
  }

  private async saveKnowledge() {
    const readField = (id: string) =>
      this.container.querySelector<HTMLTextAreaElement>(`#${id}`)?.value ?? "";
    try {
      await this.api.saveKnowledge({
        talkTemplates: readField("knowledge-talk-templates"),
        productPriority: readField("knowledge-product-priority"),
        stylePreference: readField("knowledge-style-preference"),
        compliance: readField("knowledge-compliance"),
        followUp: readField("knowledge-follow-up"),
      });
      this.modal = null;
      this.showToast("个人知识库已保存");
      this.render();
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.render();
    }
  }

  // M4.2 · 从当前客户敲定方案中沉淀知识库建议（提取结果进入待确认区，经理在知识库页勾选确认）
  private async suggestKnowledgeAction() {
    if (!this.customer || this.plans.length === 0) {
      this.showToast("请先选择客户并生成方案");
      return;
    }
    // 优先用已选方案，否则用最新一套
    const plan = this.plans.find((p) => p.planId === this.selectedPlanId) || this.plans[this.plans.length - 1];
    try {
      this.showToast("正在从方案提取沉淀建议...");
      await this.api.suggestKnowledge({
        customerId: this.customer.customerId,
        plan,
      });
      // 提取结果已由后端写入待确认区（PRD §3.5.1），刷新后由经理勾选确认
      await this.loadPendingKnowledge();
      this.renderModal();
      this.showToast(`已提取 ${this.pendingKnowledge.length} 条沉淀建议，请在待确认区勾选确认`);
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.render();
    }
  }

  // M3 · 确认选中的待确认沉淀（并入知识库对应段）
  private async confirmPendingAction() {
    const ids = [...this.pendingSelectedIds];
    if (ids.length === 0) return;
    this.pendingActioning = true;
    try {
      const { confirmed } = await this.api.confirmPendingKnowledge(ids);
      for (const id of confirmed) this.pendingSelectedIds.delete(id);
      // 刷新知识库正文（确认已并入对应段）与待确认列表
      this.knowledge = await this.api.getKnowledge();
      await this.loadPendingKnowledge();
      this.renderModal();
      this.showToast(`已确认 ${confirmed.length} 条沉淀建议并入知识库`);
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.render();
    } finally {
      this.pendingActioning = false;
      this.renderModal();
    }
  }

  // M3 · 拒绝选中的待确认沉淀
  private async rejectPendingAction() {
    const ids = [...this.pendingSelectedIds];
    if (ids.length === 0) return;
    this.pendingActioning = true;
    try {
      const { rejected } = await this.api.rejectPendingKnowledge(ids);
      for (const id of rejected) this.pendingSelectedIds.delete(id);
      await this.loadPendingKnowledge();
      this.renderModal();
      this.showToast(`已拒绝 ${rejected.length} 条沉淀建议`);
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.render();
    } finally {
      this.pendingActioning = false;
      this.renderModal();
    }
  }

  private async confirmPlan(planId: string) {
    const plan = this.plans.find((item) => item.planId === planId);
    if (!plan) return;
    try {
      await this.api.saveSnapshot(plan, { managerId: this.user?.managerId });
      this.selectedPlanId = planId;
      // 持久化 selectedPlanId 变更到当前会话
      await this.persistSession();
      this.showToast("方案已确认并保存版本快照");
      this.render();
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.render();
    }
  }

  // 标记成交：仅当前关注方案可触发（洞察提取逻辑置空占位，后续开发）
  private async confirmAdoptPlan(planId: string) {
    const plan = this.plans.find((item) => item.planId === planId);
    if (!plan) return;
    const confirmed = confirm("确认该客户已决定购买本方案并进入成交？");
    if (!confirmed) return;
    this.adoptedPlanId = planId;
    // 持久化 adoptedPlanId 到当前会话
    await this.persistSession();
    this.showToast("方案已标记为成交");
    this.renderPlans();
    // 方案采纳后自动触发知识沉淀（不阻塞 UI，失败不影响主流程）
    this.suggestKnowledgeAction().catch((err) =>
      console.warn("[extract] 方案采纳后知识提取失败（不影响主流程）:", err),
    );
  }

  // M4.1 · 确认洞察 → 标签沉淀到客户画像
  private async confirmInsightAction(insightId: string) {
    this.insightActioning = true;
    this.render();
    try {
      await this.api.confirmInsight(insightId);
      this.showToast("洞察已确认，标签已沉淀到客户画像");
      // 刷新画像（合并确认标签）+ 待确认洞察 + 提醒区
      if (this.customer) this.customer = await this.api.getCustomer(this.customer.customerId);
      await this.loadPendingInsights();
      void this.loadReminders();
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.insightActioning = false;
      this.render();
    }
  }

  // M4.1 · 驳回洞察
  private async rejectInsightAction(insightId: string) {
    this.insightActioning = true;
    this.render();
    try {
      await this.api.rejectInsight(insightId);
      this.showToast("已驳回该洞察");
      await this.loadPendingInsights();
      void this.loadReminders();
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.insightActioning = false;
      this.render();
    }
  }

  private async exportPlan(planId: string) {
    const plan = this.plans.find((item) => item.planId === planId);
    if (!plan) return;
    try {
      const blob = new Blob([plan.markdown], { type: "text/markdown;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${plan.title || plan.planId}.md`;
      anchor.click();
      URL.revokeObjectURL(url);
      this.showToast("方案已导出");
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.render();
    }
  }

  // ========== 事件处理 ==========

  private handleInput(event: Event) {
    const target = event.target as HTMLInputElement;
    if (target.id === "customer-search") { this.customerSearchValue = target.value; this.renderCustomerList(target.value); }
    if (target.id === "agent-input") this.agentInput = target.value;
    if (target.id === "case-store-search") {
      this.caseStoreQuery = target.value;
      this.renderModal();
      const input = this.container.querySelector<HTMLInputElement>("#case-store-search");
      if (input) {
        input.focus();
        const len = input.value.length;
        input.setSelectionRange(len, len);
      }
    }
    if (target.id === "login-username") this.loginUsername = target.value;
    if (target.id === "login-password") this.loginPassword = target.value;
    if (target.id === "reset-username") this.resetUsername = target.value;
    if (target.id === "reset-old-password") this.resetOldPassword = target.value;
    if (target.id === "reset-new-password") this.resetNewPassword = target.value;
    if (target.dataset.compare) {
      if (target.checked) {
        // FIFO 限制：最多 3 个，超过时取消最早选的
        if (this.compareIds.size >= 3) {
          const oldest = this.compareIds.values().next().value;
          if (oldest) this.compareIds.delete(oldest);
        }
        this.compareIds.add(target.dataset.compare);
      } else {
        this.compareIds.delete(target.dataset.compare);
      }
      // 重新渲染以更新所有复选框状态
      if (this.modal === "plan-detail") this.renderModal();
      else this.renderPlans();
      this.renderCompareButton();
    }
    // Admin form inputs
    if (target.id === "admin-form-name") this.adminFormName = target.value;
    if (target.id === "admin-form-username") this.adminFormUsername = target.value;
    if (target.id === "admin-form-customer-name") this.adminFormCustomerName = target.value;
    if (target.id === "admin-form-customer-id") this.adminFormCustomerId = target.value;
    // Admin search (skip during IME composition)
    if (target.id === "admin-manager-search" && !this.composing) { this.adminManagerSearch = target.value; this.renderAdminContent(); }
    if (target.id === "admin-customer-search" && !this.composing) { this.adminCustomerSearch = target.value; this.renderAdminContent(); }
    // Edit profile inputs：画像字段已全部只读（仅偏好/最新洞察可编辑），偏好经下拉点击交互更新
    if (target.id === "ep-insight") {
      this.editProfileData.latestInsight = target.value;
    }
    // 历史会话标题行内编辑
    if (target.dataset.action === "edit-title-input" && target.dataset.id) this.editingTitleValue = target.value;
  }

  private handleKeydown(event: KeyboardEvent) {
    if (event.key === "Enter" && (event.target as HTMLElement)?.id === "login-password") {
      void this.doLogin();
    }
    if (event.key === "Enter" && (event.target as HTMLElement)?.id === "reset-new-password") {
      void this.doResetPassword();
    }
    // 对话输入框：Enter 发送（中文输入法组词阶段不触发，避免误发送）；输入框多行输入需节流到非组词态
    if (event.key === "Enter" && (event.target as HTMLElement)?.id === "agent-input") {
      if (this.composing) return;
      event.preventDefault();
      void this.sendInput();
    }
    // 历史会话标题行内编辑：Enter 提交、Escape 取消
    if (event.key === "Enter" && (event.target as HTMLElement)?.dataset.action === "edit-title-input") {
      void this.commitEditTitle();
    }
    if (event.key === "Escape" && (event.target as HTMLElement)?.dataset.action === "edit-title-input") {
      this.cancelEditTitle();
    }
  }

  private async sendInput() {
    const input = this.container.querySelector<HTMLTextAreaElement>("#agent-input");
    const instruction = input?.value.trim() ?? "";
    if (!instruction) { this.error = "请输入指令"; this.render(); }
    else await this.sendMessage(instruction);
  }

  // 标题编辑输入框失焦时提交（Enter 提交后 editingSessionId 已清空，此处判空直接返回避免重复提交）
  private handleFocusOut(event: Event) {
    if ((event.target as HTMLElement).dataset.action === "edit-title-input") {
      void this.commitEditTitle();
    }
  }

  private async doLogin() {
    if (!this.loginUsername.trim() || !this.loginPassword.trim()) {
      this.loginError = "请输入用户名和密码";
      this.render();
      return;
    }
    this.loginLoading = true;
    this.loginError = "";
    this.render();
    try {
      this.user = await this.api.login({ username: this.loginUsername.trim(), password: this.loginPassword });
      this.loginUsername = "";
      this.loginPassword = "";
      this.loginLoading = false;
      if (this.user.role === "admin") {
        this.setHash("admin");
        this.renderAdmin();
        void this.loadAdminData("managers");
      } else {
        this.setHash("dashboard");
        this.render();
        this.connectGateway();
        void this.loadCustomers();
      }
    } catch (e) {
      this.loginError = e instanceof Error ? e.message : String(e);
      this.loginLoading = false;
      this.render();
    }
  }

  private async doLogout() {
    try { await this.api.logout(); } catch { /* ignore */ }
    this.gateway?.disconnect();
    this.gateway = null;
    this.user = null;
    this.customers = [];
    this.customer = null;
    this.plans = [];
    this.selectedPlanId = "";
    this.compareIds.clear();
    this.currentSessionId = "";
    this.sessionHistory = [];
    this.loadingSession = false;
    this.connected = false;
    this.modal = null;
    this.setHash("login");
    this.render();
  }

  private async doResetPassword() {
    if (!this.resetUsername.trim() || !this.resetOldPassword.trim() || !this.resetNewPassword.trim()) {
      this.resetMessage = "请填写所有字段";
      this.render();
      return;
    }
    if (this.resetNewPassword.length < 6) {
      this.resetMessage = "新密码至少需要 6 位";
      this.render();
      return;
    }
    this.resetLoading = true;
    this.resetMessage = "";
    this.render();
    try {
      await this.api.resetPasswordPublic({
        username: this.resetUsername.trim(),
        oldPassword: this.resetOldPassword,
        newPassword: this.resetNewPassword,
      });
      this.resetMessage = "密码重置成功，请登录";
      this.resetUsername = "";
      this.resetOldPassword = "";
      this.resetNewPassword = "";
      this.resetLoading = false;
      this.loginMode = "login";
      this.render();
    } catch (e) {
      this.resetMessage = e instanceof Error ? e.message : String(e);
      this.resetLoading = false;
      this.render();
    }
  }

  private async handleClick(event: Event) {
    // 行内标题编辑输入框内的点击不触发会话卡动作（避免编辑时误切换会话）
    if ((event.target as HTMLElement).closest("[data-action='edit-title-input']")) return;
    // 点击方案卡片（非按钮/对比勾选区域）打开详情弹窗
    const card = (event.target as HTMLElement).closest<HTMLElement>("[data-plan-id]");
    if (card && !(event.target as HTMLElement).closest("[data-action], input, .compare-check")) {
      const planId = card.dataset.planId;
      if (planId) {
        this.detailPlanId = planId;
        this.modal = "plan-detail";
        this.renderModal();
      }
      return;
    }
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-action]");
    if (!target) return;
    const action = target.dataset.action;
    if (action === "close-error") { this.error = ""; this.user?.role === "admin" ? this.renderAdmin() : this.render(); }
    if (action === "login") await this.doLogin();
    if (action === "logout") await this.doLogout();
    if (action === "toggle-reset") { this.loginMode = "reset"; this.loginError = ""; this.resetMessage = ""; this.render(); }
    if (action === "toggle-login") { this.loginMode = "login"; this.loginError = ""; this.resetMessage = ""; this.render(); }
    if (action === "reset-password") await this.doResetPassword();
    if (action === "customer" && target.dataset.id) {
      // 多选模式下点击客户行 = 勾选/取消勾选
      if (this.multiSelectMode) {
        const id = target.dataset.id;
        if (this.selectedCustomerIds.has(id)) this.selectedCustomerIds.delete(id);
        else this.selectedCustomerIds.add(id);
        this.renderCustomerList(this.customerSearchValue);
        this.renderMultiSelectBar();
        return;
      }
      await this.selectCustomer(target.dataset.id);
    }
    if (action === "toggle-customers") { this.customerPaneCollapsed = !this.customerPaneCollapsed; this.render(); }
    // M1 · Reminder 复选筛选
    if (action === "toggle-reminder" && target.dataset.filter) {
      const filter = target.dataset.filter;
      if (this.reminderFilters.has(filter)) this.reminderFilters.delete(filter);
      else this.reminderFilters.add(filter);
      this.renderReminderBar();
      this.renderCustomerList(this.customerSearchValue);
      return;
    }
    if (action === "clear-reminder") {
      this.reminderFilters.clear();
      this.renderReminderBar();
      this.renderCustomerList(this.customerSearchValue);
      return;
    }
    // M1 · 中栏 Tab 切换
    if (action === "switch-tab" && target.dataset.tab) {
      this.activeTab = target.dataset.tab as typeof this.activeTab;
      if (this.activeTab === "plans") this.plansHasNew = false;
      this.render();
      return;
    }
    // M1 · 多选模式
    if (action === "toggle-multi-select") {
      this.multiSelectMode = !this.multiSelectMode;
      if (!this.multiSelectMode) this.selectedCustomerIds.clear();
      this.render();
      return;
    }
    if (action === "toggle-customer-select" && target.dataset.id) {
      const id = target.dataset.id;
      if (this.selectedCustomerIds.has(id)) this.selectedCustomerIds.delete(id);
      else this.selectedCustomerIds.add(id);
      this.renderCustomerList(this.customerSearchValue);
      this.renderMultiSelectBar();
      return;
    }
    if (action === "ms-select-all") {
      this.customers.forEach((c) => this.selectedCustomerIds.add(c.customerId));
      this.renderCustomerList(this.customerSearchValue);
      this.renderMultiSelectBar();
      return;
    }
    // M1 · 批量任务
    if (action === "batch-insight") { await this.doBatchInsight(); return; }
    if (action === "batch-plans") { await this.doBatchPlans(); return; }
    // M5 · 右栏快捷指令 → 插入用户气泡并自动发送（自由聊天，不再直接执行生成逻辑）
    if (action === "quick-generate") { await this.sendMessage("请为该客户生成一套营销方案"); return; }
    if (action === "quick-analyze") { await this.sendMessage("请分析该客户的资产状况、风险偏好与营销机会"); return; }
    if (action === "quick-market") { await this.sendMessage("请结合当前市场环境分析该客户的配置建议"); return; }
    if (action === "quick-remember") {
      await this.openRememberCandidates();
      return;
    }
    if (action === "quick-case") { await this.sendMessage("请检索与该客户画像相似的成交案例"); return; }
    if (action === "agent-send") {
      const input = this.container.querySelector<HTMLTextAreaElement>("#agent-input");
      const instruction = input?.value.trim() ?? "";
      if (!instruction) { this.error = "请输入指令"; this.render(); }
      else await this.sendMessage(instruction);
      return;
    }
    if (action === "new-session") await this.startNewSession();
    if (action === "edit-title" && target.dataset.id) { this.startEditTitle(target.dataset.id); return; }
    if (action === "switch-session" && target.dataset.id) await this.switchSession(target.dataset.id);
    if (action === "delete-session" && target.dataset.id) await this.deleteSessionFromList(target.dataset.id);
    if (action === "edit-profile") { await this.openEditProfile(); return; }
    if (action === "save-profile") await this.doSaveProfile();
    // 编辑画像偏好下拉（antd Select multiple 风格）——全部局部 DOM 更新，不重建弹窗
    if (action === "toggle-pref-dropdown") {
      event.preventDefault();
      this.prefDropdownOpen = !this.prefDropdownOpen;
      // 仅切换 open class 控制下拉显隐，弹窗 DOM 保持不变
      const selectEl = target.closest<HTMLElement>(".pref-select");
      selectEl?.classList.toggle("open", this.prefDropdownOpen);
      return;
    }
    if (action === "toggle-pref" && target.dataset.value) {
      event.preventDefault();
      const value = target.dataset.value;
      const prefs = this.editProfileData.preferences ? [...this.editProfileData.preferences] : [];
      const idx = prefs.indexOf(value);
      if (idx >= 0) prefs.splice(idx, 1);
      else prefs.push(value);
      this.editProfileData.preferences = prefs;
      this.syncPrefTags();
      return;
    }
    if (action === "remove-pref" && target.dataset.value) {
      event.preventDefault();
      const value = target.dataset.value;
      this.editProfileData.preferences = (this.editProfileData.preferences || []).filter((p) => p !== value);
      this.syncPrefTags();
      return;
    }
    if (action === "knowledge") await this.openKnowledge();
    if (action === "case-store") await this.openCaseStore();
    if (action === "delete-case" && target.dataset.caseId) await this.deleteCaseItem(target.dataset.caseId);
    if (action === "case-filter-qual" && target.dataset.value) { this.caseStoreQualFilter = target.dataset.value as "all" | "high" | "medium"; this.renderModal(); }
    if (action === "save-knowledge") await this.saveKnowledge();
    if (action === "suggest-knowledge") await this.suggestKnowledgeAction();
    if (action === "toggle-pending-select" && target.dataset.id) {
      const id = target.dataset.id;
      if (this.pendingSelectedIds.has(id)) this.pendingSelectedIds.delete(id);
      else this.pendingSelectedIds.add(id);
      // 仅同步勾选态与按钮态，不重渲染弹窗（避免每次勾选都重建 DOM、丢失焦点）
      const item = this.container.querySelector<HTMLElement>(
        `.knowledge-pending-item[data-id="${CSS.escape(id)}"]`,
      );
      const checkbox = item?.querySelector<HTMLInputElement>("input[type='checkbox']");
      if (checkbox) checkbox.checked = this.pendingSelectedIds.has(id);
      const pending = this.pendingKnowledge.filter((p) => p.status === "pending");
      const selectedCount = pending.filter((p) => this.pendingSelectedIds.has(p.id)).length;
      const allSelected = pending.length > 0 && selectedCount === pending.length;
      const selectAllBtn = this.container.querySelector<HTMLButtonElement>(".kp-select-all");
      if (selectAllBtn) {
        selectAllBtn.textContent = allSelected ? "取消全选" : "全选";
        selectAllBtn.dataset.selected = allSelected ? "1" : "0";
      }
      const rejectBtn = this.container.querySelector<HTMLButtonElement>(
        ".kp-actions .quiet-button[data-action='reject-pending']",
      );
      const confirmBtn = this.container.querySelector<HTMLButtonElement>(
        ".kp-actions .primary-button[data-action='confirm-pending']",
      );
      if (rejectBtn) rejectBtn.disabled = selectedCount === 0 || this.pendingActioning;
      if (confirmBtn) confirmBtn.disabled = selectedCount === 0 || this.pendingActioning;
      return;
    }
    if (action === "toggle-pending-select-all") {
      const pending = this.pendingKnowledge.filter((p) => p.status === "pending");
      const shouldSelect = target.dataset.selected !== "1";
      if (shouldSelect) for (const p of pending) this.pendingSelectedIds.add(p.id);
      else this.pendingSelectedIds.clear();
      // 同步所有 checkbox 勾选态
      pending.forEach((p) => {
        const item = this.container.querySelector<HTMLElement>(
          `.knowledge-pending-item[data-id="${CSS.escape(p.id)}"]`,
        );
        const checkbox = item?.querySelector<HTMLInputElement>("input[type='checkbox']");
        if (checkbox) checkbox.checked = shouldSelect;
      });
      // 同步全选按钮文案与标记
      const selectAllBtn = this.container.querySelector<HTMLButtonElement>(
        ".kp-select-all",
      );
      if (selectAllBtn) {
        selectAllBtn.textContent = shouldSelect ? "取消全选" : "全选";
        selectAllBtn.dataset.selected = shouldSelect ? "1" : "0";
      }
      // 同步操作按钮禁用态
      const selectedCount = shouldSelect ? pending.length : 0;
      const rejectBtn = this.container.querySelector<HTMLButtonElement>(
        ".kp-actions .quiet-button[data-action='reject-pending']",
      );
      const confirmBtn = this.container.querySelector<HTMLButtonElement>(
        ".kp-actions .primary-button[data-action='confirm-pending']",
      );
      if (rejectBtn) rejectBtn.disabled = selectedCount === 0 || this.pendingActioning;
      if (confirmBtn) confirmBtn.disabled = selectedCount === 0 || this.pendingActioning;
      return;
    }
    if (action === "confirm-pending") await this.confirmPendingAction();
    if (action === "reject-pending") await this.rejectPendingAction();
    if (action === "adopt-remember") await this.adoptRemember(target.dataset.msgId ?? "", Number(target.dataset.rememberIndex));
    if (action === "send-wecom") this.sendPlanScript("wecom");
    if (action === "send-sms") this.sendPlanScript("sms");
    if (action === "send-cancel") { this.modal = null; this.renderModal(); }
    if (action === "send-confirm") {
      const channelName = this.sendConfirmChannel === "wecom" ? "企业微信" : "手机短信";
      this.modal = null;
      this.renderModal();
      this.showToast(`已发送至客户${channelName}（模拟）`);
    }
    if (action === "view-detail" && target.dataset.id) {
      this.detailPlanId = target.dataset.id;
      this.modal = "plan-detail";
      this.renderModal();
    }
    if (action === "product-detail" && target.dataset.id) {
      await this.openProductDetail(target.dataset.id);
      return;
    }
    if (action === "confirm" && target.dataset.id) await this.confirmPlan(target.dataset.id);
    if (action === "mark-adopted" && target.dataset.id) await this.confirmAdoptPlan(target.dataset.id);
    if (action === "toggle-history") { this.historyExpanded = !this.historyExpanded; this.renderPlans(); return; }
    if (action === "confirm-insight" && target.dataset.id) await this.confirmInsightAction(target.dataset.id);
    if (action === "reject-insight" && target.dataset.id) await this.rejectInsightAction(target.dataset.id);
    if (action === "export" && target.dataset.id) await this.exportPlan(target.dataset.id);
    if (action === "compare") {
      if (this.compareIds.size < 2) return;
      this.modal = "compare";
      this.renderModal();
    }
    if (action === "close-modal") {
      // 产品详情弹窗关闭后恢复到来源弹窗(如方案详情),而非直接关闭
      if (this.modal === "product-detail" && this.productDetailFrom) {
        this.modal = this.productDetailFrom;
        this.productDetailFrom = null;
      } else {
        this.modal = null;
      }
      this.renderModal();
    }
    if (action === "open-settings") { this.modal = "settings"; this.renderModal(); }
    if (action === "save-settings") {
      const form = this.container.querySelector<HTMLFormElement>("#connection-form");
      if (!form) return;
      const data = new FormData(form);
      this.config = {
        apiUrl: String(data.get("apiUrl") || defaultConfig.apiUrl),
        gatewayUrl: String(data.get("gatewayUrl") || defaultConfig.gatewayUrl),
        gatewayToken: String(data.get("gatewayToken") || ""),
        agentId: String(data.get("agentId") || defaultConfig.agentId),
        managerId: String(data.get("managerId") || defaultConfig.managerId),
      };
      localStorage.setItem(configKey, JSON.stringify(this.config));
      this.api = new FinanceApi(this.config.apiUrl);
      this.connectGateway();
      await this.loadCustomers();
    }
    // Admin actions
    if (action === "admin-tab-managers") { this.adminManagerSearch = ""; this.adminCustomerSearch = ""; await this.loadAdminData("managers"); }
    if (action === "admin-tab-customers") { this.adminManagerSearch = ""; this.adminCustomerSearch = ""; await this.loadAdminData("customers"); }
    if (action === "admin-create-manager") {
      this.adminFormName = ""; this.adminFormUsername = "";
      this.modal = "admin-create-manager"; this.renderModal();
    }
    if (action === "admin-do-create-manager") await this.doCreateManager();
    if (action === "admin-edit-manager" && target.dataset.id) {
      const mgr = this.managers.find((m) => m.managerId === target.dataset.id);
      if (mgr) {
        this.adminFormManagerId = mgr.managerId;
        this.adminFormUsername = mgr.username;
        this.adminFormName = mgr.name;
        this.modal = "admin-edit-manager";
        this.renderModal();
      }
    }
    if (action === "admin-do-edit-manager") await this.doEditManager();
    if (action === "admin-delete-manager" && target.dataset.id) await this.doDeleteManager(target.dataset.id);
    if (action === "admin-create-customer") {
      this.adminFormCustomerName = "";
      this.modal = "admin-create-customer"; this.renderModal();
    }
    if (action === "admin-do-create-customer") await this.doCreateCustomer();
    if (action === "admin-edit-customer" && target.dataset.id) {
      const cust = this.allCustomers.find((c) => c.customerId === target.dataset.id);
      if (cust) {
        this.adminFormCustomerId = cust.customerId;
        this.adminFormCustomerName = cust.name;
        this.modal = "admin-edit-customer";
        this.renderModal();
      }
    }
    if (action === "admin-do-edit-customer") await this.doEditCustomerName();
    if (action === "admin-delete-customer" && target.dataset.id) await this.doDeleteCustomer(target.dataset.id);
    if (action === "admin-assign" && target.dataset.customerId) {
      const select = this.container.querySelector<HTMLSelectElement>(`#assign-select-${target.dataset.customerId}`);
      const managerId = select?.value || null;
      await this.doAssignCustomer(target.dataset.customerId, managerId);
    }
  }

  private showToast(message: string) {
    // 清除之前 toast 的 setTimeout，避免旧定时器在新 toast 显示后触发并清空它
    if (this.toastTimer !== null) {
      window.clearTimeout(this.toastTimer);
      this.toastTimer = null;
    }
    this.toast = message;
    this.renderToast();
    this.toastTimer = window.setTimeout(() => {
      this.toast = "";
      this.renderToast();
      this.toastTimer = null;
    }, 3200);
  }

  private scrollPlansToBottom() {
    // 生成/优化后滚动到方案列表底部
    window.requestAnimationFrame(() => {
      const pane = this.container.querySelector<HTMLElement>("#tab-content");
      if (pane) pane.scrollTop = pane.scrollHeight;
    });
  }

  private sendPlanScript(channel: "wecom" | "sms") {
    const plan = this.plans.find((p) => p.planId === this.selectedPlanId);
    if (!plan) {
      this.showToast("请先选择一套方案");
      return;
    }
    // 企业微信用 wecom 话术；短信用 phone 电话话术（数组拼接为一段）
    let text: string;
    if (channel === "wecom") {
      text = plan.scripts?.wecom || "";
    } else {
      const phone = Array.isArray(plan.scripts?.phone) ? plan.scripts.phone : [];
      text = phone.join("\n\n");
    }
    if (!text) {
      this.showToast(channel === "wecom" ? "该方案暂无企业微信话术" : "该方案暂无电话话术");
      return;
    }
    this.sendConfirmChannel = channel;
    this.sendConfirmText = text;
    this.modal = "send-confirm";
    this.renderModal();
  }

  // ========== 渲染 ==========

  private render() {
    if (this.checkingAuth) {
      this.container.innerHTML = `<div class="login-shell"><div class="login-card"><div class="login-loading">加载中...</div></div></div>`;
      return;
    }
    if (!this.user) {
      this.container.innerHTML = this.loginHtml();
      return;
    }
    this.container.innerHTML = `
      <div class="app-shell">
        <header id="app-header">${this.headerHtml()}</header>
        ${this.error ? `<div class="error-banner"><strong>操作未完成</strong><span>${escapeHtml(this.error)}</span><button data-action="close-error">×</button></div>` : ""}
        <div id="reminder-bar" class="reminder-bar">${this.reminderBarHtml()}</div>
        <main class="workspace ${this.customerPaneCollapsed ? "is-customer-collapsed" : ""}">
          <aside class="customer-pane">
            <button class="customer-pane-toggle" data-action="toggle-customers" aria-label="${this.customerPaneCollapsed ? "展开客户栏" : "收起客户栏"}" title="${this.customerPaneCollapsed ? "展开客户栏" : "收起客户栏"}">${this.customerPaneCollapsed ? "›" : "‹"}</button>
            <div class="customer-pane-content">
              <div class="pane-heading"><div><span class="eyebrow">客户中心</span><h2>服务客户</h2></div><span class="count">${this.customers.length}</span></div>
              <div class="customer-toolbar">
                <label class="search"><span>⌕</span><input id="customer-search" placeholder="搜索姓名或客户号" value="${escapeHtml(this.customerSearchValue)}" /></label>
                <button class="tool-btn ${this.multiSelectMode ? "is-active" : ""}" data-action="toggle-multi-select" title="批量操作" ${this.customers.length === 0 ? "disabled" : ""}>${this.multiSelectMode ? "✓" : "☐"}批量操作</button>
              </div>
              ${this.multiSelectMode ? this.multiSelectBarHtml() : ""}
              <div id="customer-list" class="customer-list">${this.customerListHtml(this.customerSearchValue)}</div>
            </div>
          </aside>
          <section class="workspace-mid">
            <div class="tab-bar">${this.tabBarHtml()}</div>
            <div id="tab-content" class="tab-content is-${this.activeTab}">${this.activeTabContentHtml()}</div>
          </section>
          <div class="agent-pane">${this.agentPaneHtml()}</div>
        </main>
      </div>
      <div id="modal-root"></div><div id="toast-root">${this.toastHtml()}</div>`;
    this.renderModal();
    // 全量重建后若贴底锁定则回到底部（避免 loadSessionChat 之后的后台 render 把滚动重置回顶部）
    if (this.chatPinBottom) this.scrollChatToBottom();
  }

  // ========== 管理员后台渲染 ==========

  private renderAdmin() {
    if (this.checkingAuth) {
      this.container.innerHTML = `<div class="login-shell"><div class="login-card"><div class="login-loading">加载中...</div></div></div>`;
      return;
    }
    if (!this.user || this.user.role !== "admin") {
      this.render();
      return;
    }
    this.container.innerHTML = `
      <div class="app-shell">
        <header id="app-header">${this.adminHeaderHtml()}</header>
        ${this.error ? `<div class="error-banner"><strong>操作未完成</strong><span>${escapeHtml(this.error)}</span><button data-action="close-error">×</button></div>` : ""}
        <main class="admin-main">
          <div class="admin-stats">${this.adminStatsHtml()}</div>
          <div class="admin-tabs">
            <button class="admin-tab ${this.adminTab === "managers" ? "is-active" : ""}" data-action="admin-tab-managers">客户经理管理</button>
            <button class="admin-tab ${this.adminTab === "customers" ? "is-active" : ""}" data-action="admin-tab-customers">客户管理</button>
          </div>
          <div id="admin-content" class="admin-content">${this.adminTab === "managers" ? this.adminManagersHtml() : this.adminCustomersHtml()}</div>
        </main>
      </div>
      <div id="modal-root"></div><div id="toast-root">${this.toastHtml()}</div>`;
    this.renderModal();
  }

  private adminHeaderHtml() {
    return `<div class="brand"><div class="brand-mark">盈</div><div><h1>管理后台</h1><p>客户经理与客户管理</p></div></div>
      <div class="header-actions">
        <div class="user-menu">
          <button class="user-trigger"><span class="avatar user-avatar">${escapeHtml((this.user?.name || "?")[0])}</span><span class="user-name">${escapeHtml(this.user?.name || "")}</span><span class="user-arrow">▾</span></button>
          <div class="user-dropdown">
            <button class="user-dropdown-item user-dropdown-danger" data-action="logout">退出登录</button>
          </div>
        </div>
      </div>`;
  }

  private adminStatsHtml() {
    const totalManagers = this.managers.length;
    const totalCustomers = this.allCustomers.length;
    const unassigned = this.allCustomers.filter((c) => !c.assignedManagerId).length;
    return `<div class="stat-card"><span class="stat-value">${totalManagers}</span><span class="stat-label">客户经理</span></div>
      <div class="stat-card"><span class="stat-value">${totalCustomers}</span><span class="stat-label">客户总数</span></div>
      <div class="stat-card ${unassigned > 0 ? "stat-warn" : ""}"><span class="stat-value">${unassigned}</span><span class="stat-label">待分配客户</span></div>`;
  }

  private adminManagersHtml() {
    if (this.adminLoading) return `<div class="admin-loading"><div class="admin-spinner"></div><p>加载中...</p></div>`;
    const q = this.adminManagerSearch.trim().toLowerCase();
    const filtered = this.managers.filter((m) =>
      m.name.toLowerCase().includes(q) || m.username.toLowerCase().includes(q),
    );
    return `<div class="admin-section">
      <div class="admin-section-header">
        <h2>客户经理列表</h2>
        <div class="admin-section-tools">
          <div class="admin-search-wrap"><span class="admin-search-icon">⌕</span><input id="admin-manager-search" class="admin-search-input" value="${escapeHtml(this.adminManagerSearch)}" placeholder="搜索姓名或用户名..." /></div>
          <button class="primary-button" data-action="admin-create-manager">新增客户经理</button>
        </div>
      </div>
      <div class="admin-table-wrap">
        <table class="admin-table">
          <thead><tr><th>用户名</th><th>姓名</th><th>名下客户数</th><th>操作</th></tr></thead>
          <tbody>${filtered.length ? filtered.map((m) => `<tr>
            <td><span class="admin-username">${escapeHtml(m.username)}</span></td>
            <td><strong>${escapeHtml(m.name)}</strong></td>
            <td><span class="admin-count-badge">${m.customerCount}</span></td>
            <td class="admin-actions">
              <button class="quiet-button" data-action="admin-edit-manager" data-id="${escapeHtml(m.managerId)}">编辑</button>
              <button class="quiet-button danger" data-action="admin-delete-manager" data-id="${escapeHtml(m.managerId)}">删除</button>
            </td>
          </tr>`).join("") : `<tr><td colspan="4" class="admin-empty">${q ? "没有匹配的客户经理" : "暂无客户经理"}</td></tr>`}</tbody>
        </table>
      </div>
    </div>`;
  }

  private adminCustomersHtml() {
    if (this.adminLoading) return `<div class="admin-loading"><div class="admin-spinner"></div><p>加载中...</p></div>`;
    const q = this.adminCustomerSearch.trim().toLowerCase();
    const filtered = this.allCustomers.filter((c) =>
      c.name.toLowerCase().includes(q) || c.customerId.toLowerCase().includes(q),
    );
    return `<div class="admin-section">
      <div class="admin-section-header">
        <h2>客户列表</h2>
        <div class="admin-section-tools">
          <div class="admin-search-wrap"><span class="admin-search-icon">⌕</span><input id="admin-customer-search" class="admin-search-input" value="${escapeHtml(this.adminCustomerSearch)}" placeholder="搜索姓名或客户ID..." /></div>
          <button class="primary-button" data-action="admin-create-customer">新增客户</button>
        </div>
      </div>
      <div class="admin-table-wrap">
        <table class="admin-table">
          <thead><tr><th>姓名</th><th>客户ID</th><th>客户经理</th><th>分配</th><th>操作</th></tr></thead>
          <tbody>${filtered.length ? filtered.map((c) => `<tr>
            <td><strong>${escapeHtml(c.name)}</strong></td>
            <td><span class="admin-customer-id">${escapeHtml(c.customerId)}</span></td>
            <td>${c.assignedManagerName ? `<span class="admin-manager-tag">${escapeHtml(c.assignedManagerName)}</span>` : `<span class="admin-unassigned-tag">未分配</span>`}</td>
            <td class="admin-assign-cell">
              <select id="assign-select-${escapeHtml(c.customerId)}" class="admin-select">
                <option value="">-- 未分配 --</option>
                ${this.managers.map((m) => `<option value="${escapeHtml(m.managerId)}" ${c.assignedManagerId === m.managerId ? "selected" : ""}>${escapeHtml(m.name)}</option>`).join("")}
              </select>
              <button class="quiet-button" data-action="admin-assign" data-customer-id="${escapeHtml(c.customerId)}">确认</button>
            </td>
            <td class="admin-actions">
              <button class="quiet-button" data-action="admin-edit-customer" data-id="${escapeHtml(c.customerId)}">编辑</button>
              <button class="quiet-button danger" data-action="admin-delete-customer" data-id="${escapeHtml(c.customerId)}">删除</button>
            </td>
          </tr>`).join("") : `<tr><td colspan="5" class="admin-empty">${q ? "没有匹配的客户" : "暂无客户"}</td></tr>`}</tbody>
        </table>
      </div>
    </div>`;
  }

  private renderAdminContent() {
    const el = this.container.querySelector("#admin-content");
    if (el) el.innerHTML = this.adminTab === "managers" ? this.adminManagersHtml() : this.adminCustomersHtml();
  }

  // ========== 登录页面 ==========

  private loginHtml() {
    if (this.loginMode === "reset") {
      return `<div class="login-shell">
      <div class="login-card">
        <div class="login-brand"><div class="brand-mark">盈</div><h1>重置密码</h1><p>输入用户名和原密码设置新密码</p></div>
        ${this.resetMessage ? `<div class="login-message ${this.resetMessage.includes("成功") ? "login-message-success" : "login-error"}">${escapeHtml(this.resetMessage)}</div>` : ""}
        <label class="login-field"><span>用户名</span><input id="reset-username" type="text" value="${escapeHtml(this.resetUsername)}" placeholder="请输入用户名" /></label>
        <label class="login-field"><span>原密码</span><input id="reset-old-password" type="password" value="${escapeHtml(this.resetOldPassword)}" placeholder="请输入原密码" /></label>
        <label class="login-field"><span>新密码（至少6位）</span><input id="reset-new-password" type="password" value="${escapeHtml(this.resetNewPassword)}" placeholder="请输入新密码" /></label>
        <button class="primary-button login-button" data-action="reset-password" ${this.resetLoading ? "disabled" : ""}>${this.resetLoading ? "重置中..." : "重置密码"}</button>
        <div class="login-footer"><button class="link-button" data-action="toggle-login">返回登录</button></div>
      </div>
    </div>`;
    }
    return `<div class="login-shell">
      <div class="login-card">
        <div class="login-brand"><div class="brand-mark">盈</div><h1>智能财富顾问</h1><p>pi-agent 驱动的营销工作台</p></div>
        ${this.loginError ? `<div class="login-error">${escapeHtml(this.loginError)}</div>` : ""}
        ${this.resetMessage ? `<div class="login-message login-message-success">${escapeHtml(this.resetMessage)}</div>` : ""}
        <label class="login-field"><span>用户名</span><input id="login-username" type="text" value="${escapeHtml(this.loginUsername)}" placeholder="请输入用户名" autocomplete="username" /></label>
        <label class="login-field"><span>密码</span><input id="login-password" type="password" value="${escapeHtml(this.loginPassword)}" placeholder="请输入密码" autocomplete="current-password" /></label>
        <button class="primary-button login-button" data-action="login" ${this.loginLoading ? "disabled" : ""}>${this.loginLoading ? "登录中..." : "登录"}</button>
        <div class="login-footer"><button class="link-button" data-action="toggle-reset">重置密码</button></div>
      </div>
    </div>`;
  }

  // ========== 客户经理页面组件 ==========

  // M1 · Reminder 提醒条：待确认洞察 + 动态策略标签（pending 命中统计，priority 降序，只显示有客户）
  private reminderBarHtml() {
    const r = this.reminders;
    const chips: Array<{ key: string; label: string; count: number }> = [
      { key: "insight", label: "待确认洞察", count: r?.insightPending ?? 0 },
      ...this.strategyTags(),
    ];
    return `<span class="reminder-label">提醒</span>${chips.map((chip) => {
      return `<button class="reminder-chip ${this.reminderFilters.has(chip.key) ? "is-checked" : ""}" data-action="toggle-reminder" data-filter="${chip.key}">${chip.label}<span class="chip-count">${escapeHtml(String(chip.count))}</span></button>`;
    }).join("")}${this.reminderFilters.size > 0 ? `<button class="reminder-clear" data-action="clear-reminder">清除筛选</button>` : ""}`;
  }

  // M1 · 策略标签统计：从客户列表 tasks 聚合 pending 命中（排除 account_review），按 priority 降序
  private strategyTags(): Array<{ key: string; label: string; count: number }> {
    const map = new Map<string, { label: string; count: number; priority: number }>();
    for (const c of this.customers) {
      for (const t of c.tasks ?? []) {
        if (t.status !== "pending" || t.strategyType === "account_review") continue;
        const cur = map.get(t.strategyType);
        if (cur) {
          cur.count++;
          cur.priority = Math.max(cur.priority, t.priority);
        } else {
          map.set(t.strategyType, { label: t.strategyName, count: 1, priority: t.priority });
        }
      }
    }
    return [...map.entries()]
      .sort((a, b) => b[1].priority - a[1].priority)
      .map(([key, v]) => ({ key, label: v.label, count: v.count }));
  }

  // M1 · 中栏 Tab 栏
  private tabBarHtml() {
    const plansCount = this.plans.length;
    const sessionsCount = this.sessionHistory.length;
    const tabs: Array<{ key: "profile" | "plans" | "sessions"; label: string; badge?: string }> = [
      { key: "profile", label: "客户画像" },
      { key: "plans", label: "推荐方案", badge: plansCount > 0 ? String(plansCount) : undefined },
      { key: "sessions", label: "历史会话", badge: sessionsCount > 0 ? String(sessionsCount) : undefined },
    ];
    return tabs.map((tab) => {
      const isActive = this.activeTab === tab.key;
      const newDot = tab.key === "plans" && this.plansHasNew ? `<span class="tab-new-dot"></span>` : "";
      const badge = tab.badge ? `<span class="tab-badge">${escapeHtml(tab.badge)}</span>` : "";
      return `<button class="tab-item ${isActive ? "is-active" : ""} ${tab.key === "plans" && this.plansHasNew ? "has-new" : ""}" data-action="switch-tab" data-tab="${tab.key}">${tab.label}${badge}${newDot}</button>`;
    }).join("");
  }

  // M1 · 中栏 Tab 内容分发
  private activeTabContentHtml() {
    if (this.activeTab === "plans") return this.plansHtml();
    if (this.activeTab === "sessions") return this.sessionsTabHtml();
    return this.profileHtml();
  }

  // M5 · 历史会话 Tab（当前会话卡 + 历史列表，含标题/最后消息预览/消息条数/方案数/时间）
  private sessionsTabHtml() {
    if (!this.customer)
      return `<div class="sessions-empty">请先选择客户</div>`;
    const current = this.sessionHistory.find((s) => s.sessionId === this.currentSessionId);
    return `<div class="sessions-tab">
      <div class="sessions-sticky-bar">
        <button class="primary-button new-session-fab" data-action="new-session"><span class="fab-plus">+</span> 新建会话</button>
        <span class="sessions-count">${this.sessionHistory.length} 条历史</span>
      </div>
      <div class="sessions-list">
      ${current ? this.sessionCardHtml(current, true) : ""}
      ${this.sessionHistory.length > 0 ? this.sessionHistory.filter((s) => s.sessionId !== this.currentSessionId).map((s) => this.sessionCardHtml(s, false)).join("") : !current ? `<div class="sessions-empty">暂无历史会话</div>` : ""}
      </div>
    </div>`;
  }

  // M5 · 单个历史会话卡（isCurrent=true 渲染为当前会话卡；消息预览/条数来自 pi-gateway 会话摘要）
  // 当前会话卡与历史会话卡都支持重命名与删除（只有一个会话时同样可编辑/删除）
  private sessionCardHtml(s: PlanSession, isCurrent: boolean) {
    const gw = this.gatewaySessionFor(s);
    const planCount = s.plans?.length || 0;
    const msgCount = gw?.messageCount ?? 0;
    const preview = (gw?.lastMessage || s.lastInstruction || "").trim();
    const previewHtml = preview
      ? `<div class="session-card-preview">${escapeHtml(preview.length > 36 ? `${preview.slice(0, 36)}...` : preview)}</div>`
      : "";
    const meta = `${planCount} 套方案 · ${msgCount} 条消息`;
    const titleHtml = this.editingSessionId === s.sessionId
      ? `<input class="session-title-input" data-action="edit-title-input" data-id="${escapeHtml(s.sessionId)}" value="${escapeHtml(this.editingTitleValue)}" maxlength="30" />`
      : `<span class="session-card-title"><strong>${escapeHtml(this.sessionDisplayTitle(s))}</strong><button class="session-title-edit" data-action="edit-title" data-id="${escapeHtml(s.sessionId)}" title="重命名">✎</button></span>`;
    if (isCurrent) {
      return `<div class="session-card is-current">
        <div class="session-card-head">
          ${titleHtml}
          <small>${escapeHtml(new Date(s.updatedAt).toLocaleString("zh-CN"))}</small>
        </div>
        ${previewHtml}
        <div class="session-card-meta">${meta}</div>
        <div class="session-card-actions">
          <button class="danger" data-action="delete-session" data-id="${escapeHtml(s.sessionId)}">删除</button>
        </div>
        <div class="session-card-badge">当前会话</div>
      </div>`;
    }
    return `<div class="session-card" data-action="switch-session" data-id="${escapeHtml(s.sessionId)}">
      <div class="session-card-head">
        ${titleHtml}
        <small>${escapeHtml(new Date(s.updatedAt).toLocaleString("zh-CN"))}</small>
      </div>
      ${previewHtml}
      <div class="session-card-meta">${meta}</div>
      <div class="session-card-actions">
        <button data-action="switch-session" data-id="${escapeHtml(s.sessionId)}">切换</button>
        <button class="danger" data-action="delete-session" data-id="${escapeHtml(s.sessionId)}">删除</button>
      </div>
    </div>`;
  }

  // 会话卡展示标题：自定义/新默认格式优先；旧占位名或为空则实时计算默认名（不再使用 gw.title）
  private sessionDisplayTitle(s: PlanSession): string {
    if (s.title && !isOldPlaceholderTitle(s.title)) return s.title;
    return defaultSessionTitle(this.customer?.name ?? "", s.createdAt) || s.title || "";
  }

  // 进入会话标题行内编辑态（聚焦并全选）
  private startEditTitle(sessionId: string) {
    const s = this.sessionHistory.find((x) => x.sessionId === sessionId);
    this.editingSessionId = sessionId;
    this.editingTitleValue = s ? this.sessionDisplayTitle(s) : "";
    this.render();
    const input = this.container.querySelector<HTMLInputElement>(`.session-title-input[data-id="${sessionId}"]`);
    input?.focus();
    input?.select();
  }

  // 提交标题编辑：空值回退默认展示（不写后端）、超长截断 30 字符，持久化后本地刷新
  private async commitEditTitle() {
    if (!this.editingSessionId) return;
    const sessionId = this.editingSessionId;
    let value = this.editingTitleValue.trim();
    // 先清空，防止 focusout 重复触发
    this.editingSessionId = "";
    this.editingTitleValue = "";
    if (value === "") {
      this.render();
      return;
    }
    if (value.length > 30) value = value.slice(0, 30);
    try {
      const updated = await this.api.updateSession(sessionId, { title: value });
      const target = this.sessionHistory.find((s) => s.sessionId === sessionId);
      // 后端会做标题去重，用返回的最终标题刷新本地，避免撞名时界面显示不一致
      if (target) target.title = updated?.title ?? value;
      this.render();
      this.showToast("会话标题已更新");
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.render();
    }
  }

  // 取消标题编辑，标题保持不变
  private cancelEditTitle() {
    this.editingSessionId = "";
    this.editingTitleValue = "";
    this.render();
  }

  // M1 · 多选模式操作栏
  private multiSelectBarHtml() {
    return `<div class="multi-select-bar">
      <span class="ms-count">已选 ${this.selectedCustomerIds.size} / ${this.customers.length}</span>
      <div class="ms-actions">
        <button class="ms-action-btn" data-action="ms-select-all">全选</button>
        <button class="ms-action-btn ${this.runningInsight ? "is-running" : ""}" data-action="batch-insight" ${this.selectedCustomerIds.size === 0 || this.runningInsight ? "disabled" : ""}>${this.runningInsight ? '<span class="spinner"></span>' : ""}客户洞察</button>
        <button class="ms-action-btn ${this.runningPlans ? "is-running" : ""}" data-action="batch-plans" ${this.selectedCustomerIds.size === 0 || this.runningPlans ? "disabled" : ""}>${this.runningPlans ? '<span class="spinner"></span>' : ""}方案生成</button>
        <button class="ms-action-btn danger" data-action="toggle-multi-select">退出</button>
      </div>
    </div>`;
  }

  // M5 · 右栏 AI Agent 工作区（多轮对话聊天界面）
  private agentPaneHtml() {
    if (!this.customer) {
      return `<div class="agent-body"><div class="agent-empty"><div class="empty-icon">盈</div><h3>AI 营销顾问</h3><p>选择客户后，我将读取画像、适配产品并生成个性化营销方案</p></div></div>`;
    }
    const risk = this.customer.riskTolerance || "待评估";
    const riskClass = risk ? risk.toLowerCase() : "pending";
    const isPending = !this.customer.aum || this.customer.aum === 0;
    const canChat = this.chat.canChat(this.connected, isPending);
    return `<div class="agent-context">
        <span class="ctx-name">${escapeHtml(this.customer.name)}</span>
        <span class="ctx-id">${escapeHtml(this.customer.customerId)}</span>
        <span class="ctx-risk risk ${escapeHtml(riskClass)}">${escapeHtml(risk)}</span>
      </div>
      <div class="agent-body"><div class="chat-list">${this.chatListHtml()}</div></div>
      <div class="quick-actions">
        <button class="quick-chip" data-action="quick-analyze" ${canChat ? "" : "disabled"}><span class="qc-icon">▸</span>分析客户</button>
        <button class="quick-chip" data-action="quick-market" ${canChat ? "" : "disabled"}><span class="qc-icon">▸</span>市场分析</button>
        <button class="quick-chip" data-action="quick-generate" ${canChat ? "" : "disabled"}><span class="qc-icon">▸</span>生成方案</button>
        <button class="quick-chip" data-action="quick-remember" ${canChat ? "" : "disabled"}><span class="qc-icon">▸</span>记忆沉淀</button>
        <button class="quick-chip" data-action="quick-case" ${canChat ? "" : "disabled"}><span class="qc-icon">▸</span>案例检索</button>
      </div>
      <div class="agent-input-area">
        <div class="agent-input-row">
          <textarea id="agent-input" rows="1" placeholder="${this.plans.length > 0 ? "输入优化要求，如：将权益比例降低到 20%" : "输入营销指令，或点击上方快捷指令"}" ${canChat ? "" : "disabled"}>${escapeHtml(this.agentInput)}</textarea>
          <button class="agent-send-btn ${this.chat.streaming ? "is-loading" : ""}" data-action="agent-send" ${canChat ? "" : "disabled"}>${this.chat.streaming ? `<span class="send-spinner"></span>` : "↑"}</button>
        </div>
        <div class="agent-input-hint">${isPending ? "请先完善客户画像" : this.chat.streaming ? "Agent 正在处理，请稍候..." : this.plans.length > 0 ? "输入优化要求后发送，将优化当前选中方案" : "发送后将由 pi-agent 生成 3 套方案"}</div>
      </div>`;
  }

  // M5 · 对话列表（头像+气泡交替；assistant 气泡内嵌工具状态与方案卡片）
  private chatListHtml(): string {
    if (!this.chat.messages.length) {
      return `<div class="chat-empty"><div class="chat-empty-icon">盈</div><h3>开始对话</h3><p>手动输入指令或点击上方快捷指令，方案生成/优化将由 pi-agent 在会话内完成</p></div>`;
    }
    return this.chat.messages.map((msg) => {
      if (msg.role === "user") {
        return `<div class="chat-msg is-user">
          <span class="chat-avatar me">${escapeHtml((this.user?.name || "我").slice(0, 1))}</span>
          <div class="chat-copy">
            <div class="chat-bubble me">${escapeHtml(msg.text)}</div>
            ${msg.timestamp ? `<span class="chat-time">${escapeHtml(new Date(msg.timestamp).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }))}</span>` : ""}
          </div>
        </div>`;
      }
      const toolStatus = msg.toolStatus ? `<div class="chat-tool-status">${escapeHtml(msg.toolStatus)}</div>` : "";
      const plansHtml = msg.plans?.plans?.length
        ? `<div class="chat-plans">${msg.plans.plans.map((plan, i) => this.planCardHtml(plan, i, true)).join("")}</div>`
        : "";
      const candidatesHtml = (msg.candidates?.length || msg.candidateDone) ? this.rememberCardHtml(msg) : "";
      const casesHtml = msg.cases?.length ? this.caseCardHtml(msg) : "";
      const cursor = msg.streaming ? `<span class="stream-cursor">▍</span>` : "";
      return `<div class="chat-msg is-assistant">
        <span class="chat-avatar bot">盈</span>
        <div class="chat-copy">
          <div class="chat-bubble bot">${renderMarkdown(stripJsonFence(msg.text))}${cursor}</div>
          ${toolStatus}
          ${candidatesHtml}
          ${casesHtml}
          ${plansHtml}
        </div>
      </div>`;
    }).join("");
  }

  private headerHtml() {
    return `<div class="brand"><div class="brand-mark">盈</div><div><h1>智能财富顾问</h1><p>pi-agent 驱动的营销工作台</p></div></div>
      <div class="header-actions">
        <span class="connection ${this.connected ? "is-online" : ""}"><i></i>${escapeHtml(this.connectionDetail)}</span>
        <div class="user-menu">
          <button class="user-trigger"><span class="avatar user-avatar">${escapeHtml((this.user?.name || "?")[0])}</span><span class="user-name">${escapeHtml(this.user?.name || "")}</span><span class="user-arrow">▾</span></button>
          <div class="user-dropdown">
            <button class="user-dropdown-item" data-action="knowledge">个人知识库</button>
            <button class="user-dropdown-item" data-action="case-store">案例库</button>
            <button class="user-dropdown-item" data-action="open-settings">连接设置</button>
            <div class="user-dropdown-divider"></div>
            <button class="user-dropdown-item user-dropdown-danger" data-action="logout">退出登录</button>
          </div>
        </div>
      </div>`;
  }

  private customerListHtml(query: string) {
    if (this.loadingCustomers) return `<div class="skeleton-list">${"<i></i>".repeat(5)}</div>`;
    // M1 · 渲染前同步批量方案未读红点（随经理账号/刷新变化）
    this.batchUnread = this.readBatchUnread();
    const normalized = query.trim().toLowerCase();
    let filtered = this.customers.filter((item) =>
      `${item.name} ${item.customerId}`.toLowerCase().includes(normalized),
    );
    // M1 · Reminder 复选筛选（OR 关系：命中任一选中标签即显示）
    if (this.reminderFilters.size > 0) {
      filtered = filtered.filter((item) => this.matchReminderFilter(item));
    }
    if (!filtered.length) return `<div class="empty-small">没有匹配的客户</div>`;
    return filtered
      .map((item) => {
        const risk = item.riskTolerance || "";
        const riskClass = risk ? risk.toLowerCase() : "pending";
        const riskText = risk || "待评估";
        const isSelected = this.selectedCustomerIds.has(item.customerId);
        const taskCount = item.tasks?.filter((t) => t.status === "pending" && t.strategyType !== "account_review").length ?? 0;
        const hasInsight = (item.tags?.length ?? 0) > 0;
        const tags = `${taskCount > 0 ? `<span class="customer-tag task">${taskCount}任务</span>` : ""}${hasInsight ? `<span class="customer-tag insight">洞察</span>` : ""}`;
        const checkbox = this.multiSelectMode
          ? `<label class="row-checkbox"><input type="checkbox" data-action="toggle-customer-select" data-id="${escapeHtml(item.customerId)}" ${isSelected ? "checked" : ""} /></label>`
          : "";
        const unreadDot = this.batchUnread.has(item.customerId) ? `<span class="new-plan-dot" title="有批量新方案未查看"></span>` : "";
        return `<button class="customer-row ${item.customerId === this.customer?.customerId ? "is-active" : ""} ${isSelected ? "is-selected" : ""}" data-action="customer" data-id="${escapeHtml(item.customerId)}">
      ${checkbox}${unreadDot}<span class="avatar">${escapeHtml(item.name.slice(0, 1))}</span><span class="customer-copy"><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.customerId)} · ${escapeHtml(item.segment || "普通客户")}</small>${tags ? `<span class="customer-tags">${tags}</span>` : ""}</span><span class="risk ${escapeHtml(riskClass)}">${escapeHtml(riskText)}</span>
    </button>`;
      }).join("");
  }

  // M1 · Reminder 筛选匹配（OR 关系：命中任一选中标签即显示；策略标签按 pending 命中匹配，与标签计数同源）
  private matchReminderFilter(item: CustomerSummary): boolean {
    for (const key of this.reminderFilters) {
      if (key === "insight") {
        if (this.pendingInsightCustomerIds.has(item.customerId)) return true;
      } else if (item.tasks?.some((t) => t.strategyType === key && t.status === "pending") ?? false) {
        return true;
      }
    }
    return false;
  }

  private profileHtml() {
    const customer = this.customer;
    if (!customer)
      return `<div class="empty-state"><div class="empty-icon">客</div><h3>选择一位客户</h3><p>查看客户画像并生成个性化营销方案</p></div>`;
    const isPending = !customer.aum || customer.aum === 0;
    const structure = Object.entries(customer.aumStructure ?? {});
    // R1 · 近期任务 = pending 策略任务（排除 account_review，按 priority 降序）
    const tasks = (customer.tasks ?? [])
      .filter((t) => t.status === "pending" && t.strategyType !== "account_review")
      .sort((a, b) => b.priority - a.priority);
    return `<div class="profile-header"><div><span class="eyebrow">客户画像</span><h2>${escapeHtml(customer.name)}</h2><p>${escapeHtml(customer.customerId)} · ${escapeHtml(customer.occupation || "职业未录入")}</p>${isPending ? `<span class="pending-badge">待编辑</span>` : ""}</div><span class="risk-badge">风险承受 ${escapeHtml(customer.riskTolerance || "待评估")}</span></div>
      <div class="aum-card"><span>管理资产总额</span><strong>${money(customer.aum)}</strong><small>${escapeHtml(customer.segment || "客户")} · ${escapeHtml(customer.lifeCycleStage || "生命周期待完善")}</small></div>
      <section class="info-section"><div class="section-title"><h3>资产概况</h3><span>${structure.length} 类</span></div>
        <div class="allocation-summary">${structure.map(([name, value]) => `<div><span>${escapeHtml(name)}</span><b>${money(value)}</b><i style="--pct:${Math.min(100, customer.aum ? (value / customer.aum) * 100 : 0)}%"></i></div>`).join("") || `<p class="muted">暂无资产结构数据</p>`}</div>
      </section>
      <section class="info-section"><div class="section-title"><h3>近期任务</h3><span>${tasks.length}</span></div>
        <div class="task-list">${
          tasks.slice(0, 5).map((t) =>
            `<article><i></i><div><strong>${escapeHtml(t.strategyName)}</strong><small>${escapeHtml(t.triggerCondition)}</small></div></article>`,
          ).join("") || `<p class="muted">暂无策略任务</p>`
        }</div>
      </section>
      <section class="info-section"><div class="section-title"><h3>营销线索</h3></div>
        <dl class="clues"><div><dt>交易摘要</dt><dd>${escapeHtml(customer.recentTransactions || "暂无")}</dd></div><div><dt>偏好</dt><dd>${escapeHtml(customer.preferences?.join("、") || "暂无")}</dd></div><div><dt>最近联系</dt><dd>${escapeHtml(customer.lastContact ? `${customer.lastContact.date} · ${customer.lastContact.topic}` : "暂无")}</dd></div></dl>
      </section>
      ${this.pendingInsightsHtml()}
      <div class="profile-actions">
        <button class="primary-button" data-action="edit-profile">编辑客户画像</button>
      </div>`;
  }

  // M4 · 待确认洞察区（双源汇聚：批量洞察 source=llm + 方案接受 source=accepted）
  private pendingInsightsHtml(): string {
    if (!this.pendingInsights || this.pendingInsights.length === 0) return "";
    const items = this.pendingInsights.map((insight) => {
      const sourceLabel = insight.source === "accepted" ? "方案洞察" : "AI洞察";
      const tagsHtml = (insight.tags || []).map((tag) => `<em>${escapeHtml(tag)}</em>`).join("");
      return `<article class="insight-card ${insight.source}">
        <div class="insight-card-head"><span class="insight-source">${escapeHtml(sourceLabel)}</span><div class="insight-tags">${tagsHtml}</div></div>
        <p class="insight-content">${escapeHtml(insight.content)}</p>
        <div class="insight-actions">
          <button class="primary-button small" data-action="confirm-insight" data-id="${escapeHtml(insight.insightId)}" ${this.insightActioning ? "disabled" : ""}>确认沉淀</button>
          <button class="quiet-button small" data-action="reject-insight" data-id="${escapeHtml(insight.insightId)}" ${this.insightActioning ? "disabled" : ""}>驳回</button>
        </div>
      </article>`;
    }).join("");
    return `<section class="info-section insight-section"><div class="section-title"><h3>待确认洞察</h3><span>${this.pendingInsights.length}</span></div>
      <div class="insight-list">${items}</div>
      <p class="insight-hint">确认后洞察标签将沉淀到客户画像；驳回则不保留。</p>
    </section>`;
  }

  private plansHtml() {
    if (!this.customer)
      return `<div class="empty-state"><h3>营销方案区</h3><p>选择客户后由 pi-agent 加载 Skill 并生成方案</p></div>`;
    const isPending = !this.customer.aum || this.customer.aum === 0;
    if (this.loadingSession) {
      return `<div class="empty-state"><div class="empty-icon">⏳</div><h3>加载会话...</h3><p>正在读取 ${escapeHtml(this.customer.name)} 的历史方案会话</p></div>`;
    }
    if (this.chat.streaming) {
      return `<div class="empty-state"><div class="empty-icon">⏳</div><h3>Agent 处理中...</h3><p>pi-agent 正在会话内分析并生成，方案完成后将出现在右侧对话与下方列表</p></div>`;
    }
    if (!this.plans.length)
      return `<div class="plans-intro"><span class="eyebrow">营销助手</span><h2>为 ${escapeHtml(this.customer.name)} 生成方案</h2><p>pi-agent 将读取客户画像、适配产品和个人知识库，生成 3 套方案。</p><button class="primary-button large" data-action="quick-generate" ${this.connected && !isPending ? "" : "disabled"}>${isPending ? "请先完善客户画像" : this.connected ? "生成营销方案" : "等待 pi-agent 连接"}</button></div>`;
    const selectedPlan = this.plans.find((p) => p.planId === this.selectedPlanId);
    const header = `<div class="plans-header"><div><span class="eyebrow">推荐方案</span><h2>${escapeHtml(this.customer.name)} · ${this.plans.length} 套建议</h2></div><div class="plan-tools"><button id="compare-button" class="primary-button" data-action="compare" ${this.compareIds.size >= 2 ? "" : "disabled"}>对比方案 (${this.compareIds.size}/3)</button></div></div>`;
    let body: string;
    if (selectedPlan) {
      // 已选定：当前关注大卡片 + 历史方案折叠区
      const focusIndex = this.plans.findIndex((p) => p.planId === selectedPlan.planId);
      const historical = this.plans.filter((p) => p.planId !== selectedPlan.planId);
      body = `<div class="current-plan">${this.planCardHtml(selectedPlan, focusIndex)}</div>`;
      if (historical.length > 0) {
        body += `<div class="historical-plans">
          <button class="historical-header" data-action="toggle-history">历史方案 (${historical.length})<span class="historical-chevron">${this.historyExpanded ? "▲" : "▼"}</span></button>
          ${this.historyExpanded ? `<div class="historical-cards">${historical.map((plan) => this.planCardHtml(plan, this.plans.findIndex((p) => p.planId === plan.planId), true, true)).join("")}</div>` : ""}
        </div>`;
      }
    } else {
      // 未选定：平铺全部方案
      const originalPlans = this.plans.slice(0, 3);
      const optimizedPlans = this.plans.slice(3);
      body = `<div class="plan-grid">${originalPlans.map((plan, index) => this.planCardHtml(plan, index)).join("")}</div>`;
      if (optimizedPlans.length > 0) body += optimizedPlans.map((plan, index) => `<div class="plan-grid-full">${this.planCardHtml(plan, index + 3)}</div>`).join("");
    }
    return `${header}${body}
      <div class="send-buttons send-bar">
        <span class="send-bar-label">${selectedPlan ? `已选方案：${escapeHtml(selectedPlan.title)}` : "选择方案后可一键发送"}</span>
        <button class="send-button wecom" data-action="send-wecom" ${selectedPlan ? "" : "disabled"}>一键发送企业微信</button>
        <button class="send-button sms" data-action="send-sms" ${selectedPlan ? "" : "disabled"}>一键发送手机短信</button>
      </div>`;
  }

  private planCardHtml(plan: MarketingPlan, index: number, compact = false, withCompare = false) {
    const palettes = ["sage", "gold", "plum"];
    const label = index < 3 ? `方案 ${String.fromCharCode(65 + index)}` : `优化版本 ${index - 2}`;
    const isFocused = plan.planId === this.selectedPlanId;
    const isAdopted = plan.planId === this.adoptedPlanId;
    const cls = `plan-card ${palettes[index % palettes.length]} ${compact ? "chat-plan-card" : ""} ${isFocused ? "is-selected" : ""}`;
    const adoptedBadge = isAdopted ? `<span class="adopted-badge">已成交</span>` : "";
    if (compact) {
      // 迷你卡（对话气泡/历史折叠区）：仅展示 标签+标题+评分，按钮为 详情+选择方案
      const compareRow = withCompare
        ? `<div class="plan-card-head"><label class="compare-check"><input type="checkbox" data-compare="${escapeHtml(plan.planId)}" ${this.compareIds.has(plan.planId) ? "checked" : ""}/><span>对比</span></label>${adoptedBadge}</div>`
        : adoptedBadge;
      return `<article class="${cls}" data-plan-id="${escapeHtml(plan.planId)}" title="${escapeHtml(plan.title)}">
      ${compareRow}
      <span class="plan-card-eyebrow">${escapeHtml(label)}</span>
      <h4 class="plan-card-title">${escapeHtml(plan.title)}</h4>
      <span class="chat-plan-score"><b>${escapeHtml(plan.score)}</b>分</span>
      <div class="card-actions"><button class="quiet-button" data-action="view-detail" data-id="${escapeHtml(plan.planId)}">详情</button><button class="primary-button" data-action="confirm" data-id="${escapeHtml(plan.planId)}">${isFocused ? "已选方案" : "选择方案"}</button></div>
    </article>`;
    }
    return `<article class="${cls}" data-plan-id="${escapeHtml(plan.planId)}">
      <div class="plan-card-head"><label class="compare-check"><input type="checkbox" data-compare="${escapeHtml(plan.planId)}" ${this.compareIds.has(plan.planId) ? "checked" : ""}/><span>对比</span></label><span class="score"><b>${escapeHtml(plan.score)}</b>分</span>${adoptedBadge}</div>
      <div class="plan-title"><span>${escapeHtml(label)}</span><h3>${escapeHtml(plan.title)}</h3><div>${(plan.tags ?? []).map((tag) => `<em>${escapeHtml(tag)}</em>`).join("")}</div></div>
      <div class="allocation-bars">${Object.entries(plan.allocation ?? {}).map(([name, allocation]) => `<div><div><span>${escapeHtml(name)}</span><strong>${escapeHtml(allocation.pct)}%</strong></div><i><b style="width:${Math.max(0, Math.min(100, allocation.pct))}%"></b></i><small>${escapeHtml(allocation.products.join(" · "))}</small></div>`).join("")}</div>
      <div class="products-compact">${(plan.products ?? []).map((product) => `<article><span class="product-risk ${escapeHtml(product.riskLevel.toLowerCase())}">${escapeHtml(product.riskLevel)}</span><strong>${escapeHtml(product.name)}</strong></article>`).join("")}</div>
      <div class="card-actions"><button class="quiet-button" data-action="view-detail" data-id="${escapeHtml(plan.planId)}">查看详情</button>
        ${isFocused ? `<button class="primary-button" data-action="mark-adopted" data-id="${escapeHtml(plan.planId)}">${isAdopted ? "已成交" : "标记成交"}</button>` : ""}
        <button class="primary-button" data-action="confirm" data-id="${escapeHtml(plan.planId)}">${isFocused ? "已选方案" : "选择方案"}</button></div>
    </article>`;
  }

  private planDetailHtml() {
    const plan = this.plans.find((p) => p.planId === this.detailPlanId);
    if (!plan) return "";
    const phoneScripts = Array.isArray(plan.scripts?.phone) ? plan.scripts.phone : [];
    const idx = this.plans.findIndex((p) => p.planId === this.detailPlanId);
    const label = idx < 3 ? `方案 ${String.fromCharCode(65 + idx)}` : `优化版本 ${idx - 2}`;
    const diagnosisSections = parseDiagnosisSections(plan.diagnosis);
    return `<div class="modal-card plan-detail-modal"><button class="modal-close" data-action="close-modal">×</button>
      <div class="plan-detail-body">
        <span class="eyebrow">${escapeHtml(label)} · ${escapeHtml(plan.score)} 分</span>
        <h2>${escapeHtml(plan.title)}</h2>
        <div class="plan-detail-tags">${(plan.tags ?? []).map((tag) => `<em>${escapeHtml(tag)}</em>`).join("")}</div>
        <div class="plan-detail-section"><h4>诊断分析</h4>${diagnosisSections.length > 0
          ? diagnosisSections.map((section) => `<div class="diagnosis-block"><h5>${escapeHtml(section.title)}</h5><p>${escapeHtml(section.content)}</p></div>`).join("")
          : `<p>${escapeHtml(plan.diagnosis)}</p>`}</div>
        <div class="plan-detail-section"><h4>配置比例</h4>
          <div class="allocation-bars">${Object.entries(plan.allocation ?? {})
            .filter(([, allocation]) => allocation && typeof allocation === "object" && typeof (allocation as { pct?: unknown }).pct === "number" && Array.isArray((allocation as { products?: unknown }).products))
            .map(([name, allocation]) => { const entry = allocation as { pct: number; products: string[] }; const pct = Math.max(0, Math.min(100, entry.pct)); return `<div><div><span>${escapeHtml(name)}</span><strong>${escapeHtml(String(entry.pct))}%</strong></div><i><b style="width:${pct}%"></b></i><small>${escapeHtml(entry.products.join(" · "))}</small></div>`; }).join("")}</div>
        </div>
        <div class="plan-detail-section"><h4>推荐产品</h4>${(plan.products ?? []).map((product) => `<article class="plan-detail-product" data-action="product-detail" data-id="${escapeHtml(product.productId)}" title="点击查看产品详情"><span class="product-risk ${escapeHtml(product.riskLevel.toLowerCase())}">${escapeHtml(product.riskLevel)}</span><div><strong>${escapeHtml(product.name)}</strong>${product.category ? `<em class="product-cat">${escapeHtml(product.category)}</em>` : ""}<small>${escapeHtml(product.reason)}</small></div></article>`).join("")}</div>
        <div class="plan-detail-section"><h4>企业微信话术</h4><p class="plan-detail-script">${escapeHtml(plan.scripts?.wecom || "暂无话术")}</p></div>
        ${phoneScripts.length ? `<div class="plan-detail-section"><h4>电话话术</h4>${phoneScripts.map((s, i) => `<p class="plan-detail-script"><em>话术 ${i + 1}</em><br>${escapeHtml(s)}</p>`).join("")}</div>` : ""}
      </div>
      <div class="modal-actions">
        <label class="compare-check"><input type="checkbox" data-compare="${escapeHtml(plan.planId)}" ${this.compareIds.has(plan.planId) ? "checked" : ""}/><span>加入对比</span></label>
        <button class="quiet-button" data-action="export" data-id="${escapeHtml(plan.planId)}">导出方案</button>
        <button class="primary-button" data-action="confirm" data-id="${escapeHtml(plan.planId)}">${plan.planId === this.selectedPlanId ? "已选方案" : "选择方案"}</button>
      </div>
    </div>`;
  }

  /** 产品详情弹窗（数据来自 GET /api/products/:id 全字段；叠加在来源弹窗之上） */
  private async openProductDetail(productId: string) {
    // 记录来源弹窗,关闭产品详情时恢复(如方案详情弹窗)
    this.productDetailFrom = this.modal;
    this.productDetail = null;
    this.productDetailError = "";
    this.productDetailLoading = true;
    this.modal = "product-detail";
    this.renderModal();
    try {
      this.productDetail = await this.api.getProduct(productId);
    } catch (error) {
      this.productDetailError = error instanceof Error ? error.message : String(error);
    } finally {
      this.productDetailLoading = false;
      this.renderModal();
    }
  }

  private productDetailHtml() {
    const product = this.productDetail;
    // returns 为 { m1: 0.02, ... } 小数年化;标签转中文短名,渲染 "近1月 0.20%"
    const RETURN_LABELS: Record<string, string> = { m1: "近1月", m3: "近3月", m6: "近6月", y1: "近1年", ytd: "今年" };
    const returns = product?.["returns"] as Record<string, unknown> | undefined;
    const label = Object.keys(RETURN_LABELS)
      .map((k) => (returns && typeof returns === "object" && k in returns ? { label: RETURN_LABELS[k], value: returns[k] } : null))
      .filter((x): x is { label: string; value: unknown } => Boolean(x));
    // 话术参考占位符 {{name}} 替换为当前客户名
    const scriptTemplate = product?.["scriptTemplate"]
      ? String(product["scriptTemplate"]).replaceAll("{{name}}", this.customer?.name ?? "")
      : "";
    return `<div class="modal-card product-detail-modal"><button class="modal-close" data-action="close-modal">×</button>
      <div class="plan-detail-body">
        <span class="eyebrow">产品详情</span>
        <h2>${escapeHtml(product?.["name"])}</h2>
        <div class="plan-detail-tags">${["category", "subCategory", "riskLevel", "tenor"].filter((k) => product?.[k]).map((k) => `<em>${escapeHtml(k === "riskLevel" ? `${String(product?.["riskLevel"])} 级` : product?.[k])}</em>`).join("")}</div>
        ${this.productDetailLoading ? `<p class="plan-detail-script">加载中…</p>` : this.productDetailError ? `<p class="plan-detail-script">加载失败：${escapeHtml(this.productDetailError)}</p>` : product ? `
        <div class="plan-detail-section"><h4>预期收益</h4><p>${escapeHtml(product["expectedReturn"] ?? "—")}</p></div>
        <div class="plan-detail-section"><h4>产品描述</h4><p>${escapeHtml(product["description"] ?? "—")}</p></div>
        <div class="plan-detail-section"><h4>业绩基准</h4><p>${escapeHtml(product["benchmark"] ?? "—")}</p></div>
        ${label.length ? `<div class="plan-detail-section"><h4>历史收益</h4><div class="returns-grid">${label.map(({ label: name, value }) => { const pct = typeof value === "number" ? (value * 100).toFixed(2) : String(value ?? ""); return `<span><b>${escapeHtml(name)}</b> ${escapeHtml(pct)}%</span>`; }).join("")}</div></div>` : ""}
        ${Array.isArray(product["highlights"]) && (product["highlights"] as unknown[]).length ? `<div class="plan-detail-section"><h4>产品亮点</h4><div class="highlights-list">${(product["highlights"] as unknown[]).map((item) => `<em>${escapeHtml(item)}</em>`).join("")}</div></div>` : ""}
        ${Array.isArray(product["marketTags"]) && (product["marketTags"] as unknown[]).length ? `<div class="plan-detail-section"><h4>市场标签</h4><div class="highlights-list">${(product["marketTags"] as unknown[]).map((item) => `<em>${escapeHtml(item)}</em>`).join("")}</div></div>` : ""}
        ${scriptTemplate ? `<div class="plan-detail-section"><h4>话术参考</h4><p class="plan-detail-script">${escapeHtml(scriptTemplate)}</p></div>` : ""}
        ` : `<p class="plan-detail-script">暂无产品数据</p>`}
      </div>
      <div class="modal-actions">
        <button class="quiet-button" data-action="close-modal">关闭</button>
      </div>
    </div>`;
  }

  private sendConfirmHtml() {
    const plan = this.plans.find((p) => p.planId === this.selectedPlanId);
    const channelName = this.sendConfirmChannel === "wecom" ? "企业微信" : "手机短信";
    return `<div class="modal-card send-confirm-modal">
      <button class="modal-close" data-action="send-cancel">×</button>
      <span class="eyebrow">发送确认</span>
      <h2>发送至客户${escapeHtml(channelName)}</h2>
      <p class="send-confirm-meta">方案：${escapeHtml(plan?.title || "")}</p>
      <label class="send-confirm-field">
        <span>话术内容（可编辑）</span>
        <textarea id="send-confirm-text" rows="8" spellcheck="false">${escapeHtml(this.sendConfirmText)}</textarea>
      </label>
      <div class="modal-actions">
        <button class="quiet-button" data-action="send-cancel">取消</button>
        <button class="primary-button" data-action="send-confirm">确认发送</button>
      </div>
    </div>`;
  }

  private compareHtml() {
    const plans = this.plans.filter((plan) => this.compareIds.has(plan.planId));
    const rows = [
      ["方案概览", (plan: MarketingPlan) => `<strong>${escapeHtml(plan.title)}</strong><small>${escapeHtml(plan.score)} 分 · ${escapeHtml(plan.tags.join(" / "))}</small>`],
      ["配置比例", (plan: MarketingPlan) => Object.entries(plan.allocation).map(([key, value]) => `<span>${escapeHtml(key)} ${escapeHtml(value.pct)}%</span>`).join("")],
      ["产品组合", (plan: MarketingPlan) => plan.products.map((item) => `<span>${escapeHtml(item.name)} <i>${escapeHtml(item.riskLevel)}</i></span>`).join("")],
      ["微信话术", (plan: MarketingPlan) => `<p>${escapeHtml(plan.scripts.wecom)}</p>`],
    ] as const;
    return `<div class="modal-card compare-modal"><button class="modal-close" data-action="close-modal">×</button><span class="eyebrow">结构化对比</span><h2>方案差异一目了然</h2><div class="compare-table" style="--cols:${plans.length}"><div class="compare-head"><b>对比维度</b>${plans.map((plan) => `<b>${escapeHtml(plan.title)}</b>`).join("")}</div>${rows.map(([label, render]) => `<div class="compare-row"><strong>${label}</strong>${plans.map((plan) => `<div>${render(plan)}</div>`).join("")}</div>`).join("")}</div></div>`;
  }

  private knowledgeHtml() {
    const canSuggest = !!this.customer && this.plans.length > 0;
    const pending = this.pendingKnowledge.filter((p) => p.status === "pending");
    const selectedCount = pending.filter((p) => this.pendingSelectedIds.has(p.id)).length;
    const allSelected = pending.length > 0 && pending.every((p) => this.pendingSelectedIds.has(p.id));
    const pendingBlock = pending.length > 0
      ? `<section class="knowledge-pending"><div class="knowledge-pending-head"><h3>待确认沉淀</h3><span>${pending.length}</span></div>
      <p class="knowledge-pending-tip">方案采纳自动提取的内容，勾选后确认并入知识库对应段落，或直接拒绝。</p>
      <div class="knowledge-pending-list">${pending.map((item) => `<label class="knowledge-pending-item" data-action="toggle-pending-select" data-id="${escapeHtml(item.id)}"><input type="checkbox" ${this.pendingSelectedIds.has(item.id) ? "checked" : ""}><span class="kp-field">${escapeHtml(FIELD_LABELS[item.field] || item.field)}</span><span class="kp-content">${escapeHtml(item.content)}</span></label>`).join("")}</div>
      <div class="kp-actions"><button class="quiet-button kp-select-all" data-action="toggle-pending-select-all" data-selected="${allSelected ? "1" : "0"}">${allSelected ? "取消全选" : "全选"}</button><button class="quiet-button" data-action="reject-pending" ${selectedCount === 0 || this.pendingActioning ? "disabled" : ""}>拒绝选中</button><button class="primary-button" data-action="confirm-pending" ${selectedCount === 0 || this.pendingActioning ? "disabled" : ""}>确认选中并入知识库</button></div></section>`
      : `<p class="knowledge-pending-empty">暂无待确认沉淀建议，选中方案后可点击「沉淀建议」从方案提取。</p>`;
    return `<div class="modal-card knowledge-modal"><button class="modal-close" data-action="close-modal">×</button><span class="eyebrow">个人知识库</span><h2>沉淀你的营销经验</h2><p>分别维护五类内容。固定标题由后台统一组合为 Markdown，生成时由 pi-agent Skill 加载。</p><div class="knowledge-fields">
      <label><strong>话术模板</strong><span>沉淀常用的开场、需求挖掘和跟进表达</span><textarea id="knowledge-talk-templates" spellcheck="false" placeholder="例如：先结合客户近期到期资金自然开场……">${escapeHtml(this.knowledge.talkTemplates)}</textarea></label>
      <label><strong>产品优先度</strong><span>记录产品、品类或营销活动的推荐顺序</span><textarea id="knowledge-product-priority" spellcheck="false" placeholder="例如：到期承接优先短期限固收产品……">${escapeHtml(this.knowledge.productPriority)}</textarea></label>
      <label><strong>风格偏好</strong><span>定义方案和触客话术的语气与表达风格</span><textarea id="knowledge-style-preference" spellcheck="false" placeholder="例如：专业、简洁，避免过度营销表达……">${escapeHtml(this.knowledge.stylePreference)}</textarea></label>
      <label><strong>合规经验</strong><span>沉淀合规审查中的风险提示、报备与修正经验</span><textarea id="knowledge-compliance" spellcheck="false" placeholder="例如：R4 产品需线下双录确认风险揭示……">${escapeHtml(this.knowledge.compliance)}</textarea></label>
      <label><strong>跟进策略</strong><span>记录触客、回访的节奏与提醒方式</span><textarea id="knowledge-follow-up" spellcheck="false" placeholder="例如：方案发出次日跟进到期资金承接意向……">${escapeHtml(this.knowledge.followUp)}</textarea></label>
    </div>${pendingBlock}<div class="modal-actions"><button class="quiet-button" data-action="close-modal">取消</button><button class="quiet-button" data-action="suggest-knowledge" ${canSuggest ? "" : "disabled"} title="${canSuggest ? "从当前客户方案提取沉淀建议" : "请先选择客户并生成方案"}">沉淀建议</button><button class="primary-button" data-action="save-knowledge">保存</button></div></div>`;
  }

  // M5.2 · 记忆沉淀：以对话形式发送 prompt，AI 提炼后以记忆卡片回复
  private async openRememberCandidates() {
    if (!this.customer) { this.showToast("请先选择客户"); return; }
    if (!this.currentSessionKey) { this.showToast("当前会话缺少上下文，请先发起对话"); return; }
    // 用户主动触发记忆沉淀后始终锚定最新对话：解除此前上滚导致的贴底锁定，
    // 否则本次插入的用户气泡与新回复不会贴底跟随（renderAgentPane 会将该态回退到顶部）。
    this.chatPinBottom = true;
    const promptText = "请从最近的对话中提炼可沉淀的经验知识，供我确认后写入个人知识库。";
    // 1. 以对话形式发送 prompt（用户气泡）
    this.chat.messages.push({
      id: this.chat.nextMessageId(),
      role: "user",
      text: promptText,
      timestamp: new Date().toISOString(),
    });
    this.renderAgentPane();
    this.scrollChatToBottom();
    // 2. 分析候选后，AI 以记忆卡片回复
    try {
      const candidates = await this.api.suggestCandidates({
        customerId: this.customer.customerId,
        sessionKey: this.currentSessionKey,
      });
      const list = Array.isArray(candidates) ? candidates : [];
      this.chat.messages.push({
        id: this.chat.nextMessageId(),
        role: "assistant",
        text: list.length > 0
          ? "结合最近对话，我梳理出以下可沉淀的经验，请勾选确认："
          : "结合最近的对话，暂未发现值得沉淀的通用经验。",
        candidates: list.length > 0 ? list : undefined,
        timestamp: new Date().toISOString(),
      });
    } catch (e) {
      this.chat.messages.push({
        id: this.chat.nextMessageId(),
        role: "assistant",
        text: `记忆沉淀分析失败：${e instanceof Error ? e.message : String(e)}`,
        timestamp: new Date().toISOString(),
      });
    }
    this.renderAgentPane();
    this.scrollChatToBottom();
  }

  // 候选卡片 HTML（对话内嵌，完全仿照方案小卡片 chat-plan-card）
  private rememberCardHtml(msg: ChatMessage): string {
    if (msg.candidateDone) {
      return `<div class="remember-done">${escapeHtml(msg.resultText || "已并入个人知识库")}</div>`;
    }
    const palettes = ["sage", "gold", "plum"];
    const confidenceLabel: Record<string, string> = { high: "高", medium: "中", low: "低" };
    const items = (msg.candidates ?? []).map((c, i) => {
      const badge = CATEGORY_LABELS[c.category] || c.category || "话术模板";
      const tags = (c.tags ?? []).length > 0
        ? `<span class="remember-item-tags">${c.tags.map((t) => `<em>${escapeHtml(t)}</em>`).join("")}</span>`
        : "";
      return `<article class="plan-card ${palettes[i % palettes.length]} chat-plan-card remember-item" data-msg-id="${escapeHtml(msg.id)}" data-remember-index="${i}">
        <div class="plan-card-head"><span class="chat-plan-score remember-conf"><b>${escapeHtml(confidenceLabel[c.confidence] || "中")}</b>置信</span></div>
        <span class="plan-card-eyebrow">${escapeHtml(badge)}</span>
        <h4 class="plan-card-title remember-item-content">${escapeHtml(c.summary || c.content)}</h4>
        ${tags}
        <div class="card-actions">
          <button class="primary-button" data-action="adopt-remember" data-msg-id="${escapeHtml(msg.id)}" data-remember-index="${i}">采纳</button>
        </div>
      </article>`;
    }).join("");
    return `<div class="chat-plans">${items}</div>`;
  }

  // M0 · 相似案例卡片 HTML（对话内嵌，只读展示检索结果）
  private caseCardHtml(msg: ChatMessage): string {
    const items = (msg.cases ?? []).map((c) => {
      const tags = (c.tags ?? []).length > 0
        ? `<span class="case-tags">${c.tags.map((t) => `<em>${escapeHtml(t)}</em>`).join("")}</span>`
        : "";
      const alloc = Object.entries(c.allocation ?? {}).length > 0
        ? `<div class="case-alloc">${Object.entries(c.allocation).map(([key, v]) => `<span>${escapeHtml(key)} ${v.pct}%</span>`).join("")}</div>`
        : "";
      return `<article class="case-item">
        <div class="case-item-head"><strong>${escapeHtml(c.title)}</strong><span class="case-score">${escapeHtml(c.score)}分</span></div>
        ${tags}
        <p class="case-diagnosis">${escapeHtml(c.diagnosis || "")}</p>
        ${alloc}
      </article>`;
    }).join("");
    return `<div class="chat-case"><div class="case-title">相似案例<span class="case-count">${(msg.cases?.length ?? 0)} 个参考</span></div><div class="case-list">${items}</div></div>`;
  }

  // M3 · 打开案例库弹窗（加载当前经理的案例列表）
  private async openCaseStore() {
    this.caseStoreLoading = true;
    this.modal = "case-store";
    this.renderModal();
    try {
      this.caseStore = await this.api.listCases();
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.render();
    } finally {
      this.caseStoreLoading = false;
      this.renderModal();
    }
  }

  // M3 · 删除单个案例
  private async deleteCaseItem(caseId: string) {
    try {
      await this.api.deleteCase(caseId);
      this.caseStore = this.caseStore.filter((c) => c.caseId !== caseId);
      this.renderModal();
      this.showToast("案例已删除");
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.render();
    }
  }

  // M3 · 案例库弹窗 HTML（始终展示筛选栏，空态只替换列表区域）
  private caseStoreHtml(): string {
    if (this.caseStoreLoading) {
      return `<div class="modal-card case-store-modal"><button class="modal-close" data-action="close-modal">×</button><span class="eyebrow">案例库</span><h2>沉淀的成交案例</h2><div class="case-store-loading">加载中…</div></div>`;
    }
    const nameOf = (customerId: string) => {
      const c = this.customers.find((x) => x.customerId === customerId);
      return c ? c.name : customerId;
    };
    // 筛选：质量 + 关键词（客户名 / 客户ID / 标签 / 标题 / 诊断）
    let list = this.caseStore;
    if (this.caseStoreQualFilter !== "all") list = list.filter((c) => c.quality === this.caseStoreQualFilter);
    const q = this.caseStoreQuery.trim().toLowerCase();
    if (q) {
      list = list.filter((c) => {
        const name = nameOf(c.customerId).toLowerCase();
        const tags = (c.summary.tags ?? []).join(" ").toLowerCase();
        const title = (c.summary.title || "").toLowerCase();
        const diagnosis = (c.summary.diagnosis || "").toLowerCase();
        return name.includes(q) || c.customerId.toLowerCase().includes(q) || tags.includes(q) || title.includes(q) || diagnosis.includes(q);
      });
    }
    const filterBar = `<div class="case-store-filter">
      <input id="case-store-search" class="case-filter-input" value="${escapeHtml(this.caseStoreQuery)}" placeholder="搜索客户名 / 标签 / 标题关键词" spellcheck="false" />
      <div class="case-filter-quals">${([["all", "全部"], ["high", "优质"], ["medium", "普通"]] as const).map(([v, label]) => `<button class="case-filter-qual ${this.caseStoreQualFilter === v ? "is-active" : ""}" data-action="case-filter-qual" data-value="${v}">${label}</button>`).join("")}</div>
    </div>`;
    if (this.caseStore.length === 0) {
      return `<div class="modal-card case-store-modal"><button class="modal-close" data-action="close-modal">×</button><span class="eyebrow">案例库</span><h2>沉淀的成交案例</h2>${filterBar}<p class="case-store-empty">暂无案例。方案成交（评分 ≥ 7）时会自动沉淀为案例，供后续相似客户参考。</p><div class="modal-actions"><button class="primary-button" data-action="close-modal">关闭</button></div></div>`;
    }
    const items = list.map((c) => {
      const tags = (c.summary.tags ?? []).length > 0
        ? `<span class="case-store-tags">${c.summary.tags.map((t) => `<em>${escapeHtml(t)}</em>`).join("")}</span>`
        : "";
      const date = c.createdAt ? new Date(c.createdAt).toLocaleString("zh-CN") : "";
      return `<div class="case-store-item">
        <div class="case-store-item-head">
          <div><strong>${escapeHtml(c.summary.title)}</strong><span class="case-store-quality ${c.quality}">${c.quality === "high" ? "优质" : "普通"}</span></div>
          <span class="case-store-score">${escapeHtml(c.summary.score)}分</span>
        </div>
        ${tags}
        <p class="case-store-diagnosis">${escapeHtml(c.summary.diagnosis || "")}</p>
        <div class="case-store-meta"><span>客户 ${escapeHtml(nameOf(c.customerId))}</span><span>${escapeHtml(date)}</span></div>
        <div class="case-store-actions"><button class="quiet-button danger-text" data-action="delete-case" data-case-id="${escapeHtml(c.caseId)}">删除</button></div>
      </div>`;
    }).join("");
    const listHtml = list.length === 0
      ? `<div class="case-store-empty">没有符合条件的案例</div>`
      : `<div class="case-store-list">${items}</div>`;
    return `<div class="modal-card case-store-modal"><button class="modal-close" data-action="close-modal">×</button><span class="eyebrow">案例库</span><h2>沉淀的成交案例</h2><p>方案成交（评分 ≥ 7）自动沉淀，供相似客户检索参考。</p>${filterBar}${listHtml}<div class="modal-actions"><button class="primary-button" data-action="close-modal">关闭</button></div></div>`;
  }

  // M5.2 · 采纳单条候选知识
  private async adoptRemember(msgId: string, index: number) {
    const msg = this.chat.messages.find((m) => m.id === msgId);
    const candidates = msg?.candidates ?? [];
    if (!msg || candidates.length === 0 || index < 0 || index >= candidates.length) return;
    const c = candidates[index];
    try {
      const result = await this.api.applyKnowledge([{ category: c.category, content: c.content }]);
      // 从候选列表移除已采纳条目
      msg.candidates = candidates.filter((_, i) => i !== index);
      // 候选全部采纳后标记完成
      if (msg.candidates.length === 0) {
        msg.candidateDone = true;
        msg.resultText = `已沉淀全部 ${result.applied} 条经验`;
      }
      this.renderAgentPane();
      this.scrollChatToBottom();
      this.showToast("已采纳并入知识库");
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.render();
    }
  }

  private editProfileHtml() {
    if (!this.customer) return "";
    const d = this.editProfileData;
    const aumStructure = d.aumStructure || {};
    const computedAum = Object.values(aumStructure).reduce((sum, v) => sum + (Number(v) || 0), 0);
    const aumKeys = ["活期", "定期存款", "理财", "基金", "保险"];
    const prefs = d.preferences || [];
    // 偏好下拉候选：seed 全客户偏好去重 + 当前已选（含历史自定义值，保证已选标签可见）
    const options = Array.from(new Set([...FinanceAdvisorApp.PREFERENCE_OPTIONS, ...prefs]));
    const prefTags = prefs.length
      ? prefs.map((p) => `<span class="pref-tag">${escapeHtml(p)}<button type="button" class="pref-tag-remove" data-action="remove-pref" data-value="${escapeHtml(p)}" aria-label="移除">×</button></span>`).join("")
      : '<span class="pref-placeholder">请选择偏好</span>';
    const prefOptions = `<div class="pref-dropdown">${
      options.length
        ? options.map((opt) => {
            const selected = prefs.includes(opt);
            // 交互统一挂在 label 上（checkbox 仅作视觉装饰，pointer-events:none），
            // 避免原生 checkbox 勾选与 label 隐式关联派发的合成 click 双重触发导致勾选状态错乱
            return `<label class="pref-option ${selected ? "is-selected" : ""}" data-action="toggle-pref" data-value="${escapeHtml(opt)}"><input type="checkbox" tabindex="-1" ${selected ? "checked" : ""} /><span>${escapeHtml(opt)}</span>${selected ? '<em class="pref-check">✓</em>' : ""}</label>`;
          }).join("")
        : '<div class="pref-empty">暂无可用选项</div>'
    }</div>`;
    const insight = d.latestInsight ?? "";
    return `<div class="modal-card edit-profile-modal"><div class="edit-profile-scroll"><button class="modal-close" data-action="close-modal">×</button><span class="eyebrow">编辑客户画像</span><h2>${escapeHtml(this.customer.name)}</h2>
      <div class="edit-profile-form">
        <label><strong>职业</strong><input value="${escapeHtml(d.occupation || "")}" disabled /></label>
        <label><strong>客户分层</strong><input value="${escapeHtml(d.segment || "")}" disabled /></label>
        <label><strong>风险承受</strong><input value="${escapeHtml(d.riskTolerance || "未评估")}" disabled /></label>
        <label><strong>交易摘要</strong><input value="${escapeHtml(d.recentTransactions || "")}" disabled /></label>
        <label><strong>生命周期</strong><input value="${escapeHtml(d.lifeCycleStage || "")}" disabled /></label>
        <div class="edit-field"><strong>偏好</strong>
          <div class="pref-select${this.prefDropdownOpen ? " open" : ""}">
            <div class="pref-select-control" data-action="toggle-pref-dropdown" role="button" tabindex="0">
              <div class="pref-tags">${prefTags}</div>
              <span class="pref-arrow">▾</span>
            </div>
            ${prefOptions}
          </div>
        </div>
        <label><strong>最近联系渠道</strong><input value="${escapeHtml(d.lastContact?.channel || "")}" disabled /></label>
        <label><strong>最近联系日期</strong><input type="date" value="${escapeHtml(d.lastContact?.date || "")}" disabled /></label>
        <label><strong>最近联系主题</strong><input value="${escapeHtml(d.lastContact?.topic || "")}" disabled /></label>
        <label><strong>风险评估日期</strong><input type="date" value="${escapeHtml(d.riskAssessmentDate || "")}" disabled /></label>
        <fieldset class="aum-structure-set">
          <legend>资产结构</legend>
          <div class="aum-structure-grid">
            ${aumKeys.map((key) => `<label>${key}<input type="number" value="${aumStructure[key] || 0}" min="0" disabled /></label>`).join("")}
          </div>
          <div class="aum-computed">推算 AUM：<strong>${money(computedAum)}</strong></div>
        </fieldset>
        <div class="insight-editor">
          <div class="insight-editor-head"><strong>最新客户洞察</strong></div>
          <textarea id="ep-insight" class="insight-editor-input" spellcheck="false" placeholder="输入最新客户洞察（支持 Markdown：**加粗**、- 列表、## 标题 等）...">${escapeHtml(insight)}</textarea>
        </div>
      </div>
      <div class="modal-actions"><button class="quiet-button" data-action="close-modal">取消</button><button class="primary-button" data-action="save-profile">保存画像</button></div></div></div>`;
  }

  private settingsHtml() {
    return `<form id="connection-form" class="settings-card">
      <label>业务 API<input name="apiUrl" value="${escapeHtml(this.config.apiUrl)}" /></label>
      <label>Gateway<input name="gatewayUrl" value="${escapeHtml(this.config.gatewayUrl)}" /></label>
      <label>访问令牌<input name="gatewayToken" type="password" value="${escapeHtml(this.config.gatewayToken)}" /></label>
      <div class="settings-row"><label>Agent ID<input name="agentId" value="${escapeHtml(this.config.agentId)}" /></label><label>客户经理 ID<input name="managerId" value="${escapeHtml(this.config.managerId)}" /></label></div>
      <button type="button" class="primary-button" data-action="save-settings">保存并重连</button>
    </form>`;
  }

  private toastHtml() {
    return this.toast ? `<div class="toast">✓ ${escapeHtml(this.toast)}</div>` : "";
  }

  // ========== 局部渲染 ==========

  private renderHeader() {
    const header = this.container.querySelector("#app-header");
    if (header) header.innerHTML = this.headerHtml();
  }
  private renderCustomerList(query = "") {
    const list = this.container.querySelector("#customer-list");
    if (list) list.innerHTML = this.customerListHtml(query);
  }
  private renderPlans() {
    // M1 · 方案内容现在在中栏 Tab 内，仅在"推荐方案"Tab 时更新
    const content = this.container.querySelector("#tab-content");
    if (content && this.activeTab === "plans") {
      content.className = `tab-content is-${this.activeTab}`;
      content.innerHTML = this.plansHtml();
    }
    // 更新 Tab 栏的方案计数 + "新"标记
    const tabBar = this.container.querySelector(".tab-bar");
    if (tabBar) tabBar.innerHTML = this.tabBarHtml();
  }
  // M5 · 局部更新右栏对话面板
  private renderAgentPane() {
    const agent = this.container.querySelector(".agent-pane");
    if (agent) agent.innerHTML = this.agentPaneHtml();
    // 重建 DOM 后，若处于贴底锁定态，或正在流式输出（需持续跟随最新输出），则保持滚动到底，
    // 避免刷新后被后台 render 重置回顶部。
    if (this.chatPinBottom || this.chat.streaming) this.scrollChatToBottom();
  }
  // 切换客户后局部刷新：只更新中栏 tab/内容与右栏对话，并同步客户列表高亮，
  // 不重建 #customer-list DOM，避免客户列表滚动回到顶部。
  private renderAfterSwitch() {
    const tabBar = this.container.querySelector(".tab-bar");
    if (tabBar) tabBar.innerHTML = this.tabBarHtml();
    const content = this.container.querySelector("#tab-content");
    if (content) {
      content.className = `tab-content is-${this.activeTab}`;
      content.innerHTML = this.activeTabContentHtml();
    }
    this.renderAgentPane();
    // 同步客户列表选中高亮（仅切 class，不重绘列表）
    this.container.querySelectorAll<HTMLElement>("#customer-list .customer-row").forEach((row) => {
      row.classList.toggle("is-active", row.dataset.id === this.customer?.customerId);
    });
  }
  // M5 · 滚动对话列表到底部（流式输出/消息插入后）。
  // 受 chatPinBottom 控制：会话加载/切换后默认贴底；用户上滚查看历史时由滚动监听解锁。
  // 但流式输出期间强制贴底跟随最新输出，即使此时用户正在向上滚动也不脱离。
  private scrollChatToBottom() {
    this.bindChatScrollUnlock();
    window.requestAnimationFrame(() => {
      if (!this.chatPinBottom && !this.chat.streaming) return;
      const list = this.container.querySelector<HTMLElement>(".chat-list");
      if (list) list.scrollTop = list.scrollHeight;
    });
  }
  // 监听对话列表滚动：滚到最底视为保持贴底；向上滚动查看历史则解除贴底锁定。
  // 流式输出期间不解除锁定，保证新输出持续回到最新对话。
  private bindChatScrollUnlock() {
    if (this.chatListScrollBound) return;
    this.chatListScrollBound = true;
    this.container.addEventListener(
      "scroll",
      (e) => {
        const target = e.target as HTMLElement;
        if (!target.classList.contains("chat-list")) return;
        if (this.chat.streaming) return;
        this.chatPinBottom = target.scrollTop + target.clientHeight >= target.scrollHeight - 1;
      },
      true, // capture：scroll 不冒泡，需采集后代 .chat-list 的滚动
    );
  }
  // M1 · 局部更新提醒条
  private renderReminderBar() {
    const bar = this.container.querySelector("#reminder-bar");
    if (bar) bar.innerHTML = this.reminderBarHtml();
  }
  // M1 · 局部更新多选操作栏
  private renderMultiSelectBar() {
    // 多选栏在 customer-pane-content 内，search 之后
    const pane = this.container.querySelector(".customer-pane-content");
    if (!pane) return;
    const existing = pane.querySelector(".multi-select-bar");
    if (this.multiSelectMode) {
      const html = this.multiSelectBarHtml();
      if (existing) existing.outerHTML = html;
      else {
        const toolbar = pane.querySelector(".customer-toolbar");
        if (toolbar) toolbar.insertAdjacentHTML("afterend", html);
      }
    } else if (existing) {
      existing.remove();
    }
  }
  private renderCompareButton() {
    const button = this.container.querySelector<HTMLButtonElement>("#compare-button");
    if (!button) return;
    button.disabled = this.compareIds.size < 2;
    button.textContent = `对比方案 (${this.compareIds.size}/3)`;
  }
  private renderModal() {
    const modalRoot = this.container.querySelector("#modal-root");
    if (!modalRoot) return;
    let content = "";
    if (this.modal === "compare") content = this.compareHtml();
    else if (this.modal === "plan-detail") content = this.planDetailHtml();
    else if (this.modal === "product-detail") content = this.productDetailHtml();
    else if (this.modal === "send-confirm") content = this.sendConfirmHtml();
    else if (this.modal === "knowledge") content = this.knowledgeHtml();
    else if (this.modal === "case-store") content = this.caseStoreHtml();
    else if (this.modal === "edit-profile") content = this.editProfileHtml();
    else if (this.modal === "settings") content = this.settingsModalHtml();
    else if (this.modal === "admin-create-manager") content = this.adminCreateManagerModalHtml();
    else if (this.modal === "admin-edit-manager") content = this.adminEditManagerModalHtml();
    else if (this.modal === "admin-create-customer") content = this.adminCreateCustomerModalHtml();
    else if (this.modal === "admin-edit-customer") content = this.adminEditCustomerModalHtml();
    modalRoot.innerHTML = content ? `<div class="modal-backdrop">${content}</div>` : "";
  }

  /** 局部刷新偏好标签区与下拉选项选中态（勾选/移除后调用，不重建弹窗，避免闪回与跳顶） */
  private syncPrefTags() {
    const modalRoot = this.container.querySelector("#modal-root");
    if (!modalRoot) return;
    const prefs = this.editProfileData.preferences || [];
    // 1) 刷新已选标签区
    const tagsEl = modalRoot.querySelector<HTMLElement>(".pref-tags");
    if (tagsEl) {
      tagsEl.innerHTML = prefs.length
        ? prefs.map((p) => `<span class="pref-tag">${escapeHtml(p)}<button type="button" class="pref-tag-remove" data-action="remove-pref" data-value="${escapeHtml(p)}" aria-label="移除">×</button></span>`).join("")
        : '<span class="pref-placeholder">请选择偏好</span>';
    }
    // 2) 同步每个选项的选中态（高亮 / checkbox / ✓ 标记）
    modalRoot.querySelectorAll<HTMLElement>(".pref-option").forEach((optEl) => {
      const value = optEl.dataset.value;
      if (value === undefined) return;
      const selected = prefs.includes(value);
      optEl.classList.toggle("is-selected", selected);
      const checkbox = optEl.querySelector<HTMLInputElement>('input[type="checkbox"]');
      if (checkbox) checkbox.checked = selected;
      const check = optEl.querySelector<HTMLElement>(".pref-check");
      if (selected && !check) {
        const mark = document.createElement("em");
        mark.className = "pref-check";
        mark.textContent = "✓";
        optEl.appendChild(mark);
      } else if (!selected && check) {
        check.remove();
      }
    });
  }

  private adminCreateManagerModalHtml() {
    return `<div class="modal-card admin-modal"><button class="modal-close" data-action="close-modal">×</button><span class="eyebrow">新增客户经理</span><h2>创建账号</h2>
      <label class="login-field"><span>用户名</span><input id="admin-form-username" value="${escapeHtml(this.adminFormUsername)}" placeholder="请输入用户名" /></label>
      <label class="login-field"><span>姓名</span><input id="admin-form-name" value="${escapeHtml(this.adminFormName)}" placeholder="请输入姓名" /></label>
      <small>初始密码为 123456</small>
      <div class="modal-actions"><button class="quiet-button" data-action="close-modal">取消</button><button class="primary-button" data-action="admin-do-create-manager">创建</button></div></div>`;
  }

  private adminEditManagerModalHtml() {
    return `<div class="modal-card admin-modal"><button class="modal-close" data-action="close-modal">×</button><span class="eyebrow">编辑客户经理</span><h2>修改信息</h2>
      <label class="login-field"><span>用户名</span><input id="admin-form-username" value="${escapeHtml(this.adminFormUsername)}" placeholder="请输入用户名" /></label>
      <label class="login-field"><span>姓名</span><input id="admin-form-name" value="${escapeHtml(this.adminFormName)}" placeholder="请输入姓名" /></label>
      <div class="modal-actions"><button class="quiet-button" data-action="close-modal">取消</button><button class="primary-button" data-action="admin-do-edit-manager">保存</button></div></div>`;
  }

  private adminCreateCustomerModalHtml() {
    return `<div class="modal-card admin-modal"><button class="modal-close" data-action="close-modal">×</button><span class="eyebrow">新增客户</span><h2>创建客户</h2>
      <label class="login-field"><span>客户姓名</span><input id="admin-form-customer-name" value="${escapeHtml(this.adminFormCustomerName)}" placeholder="请输入客户姓名" /></label>
      <small>创建后可在客户列表中将客户分配给客户经理</small>
      <div class="modal-actions"><button class="quiet-button" data-action="close-modal">取消</button><button class="primary-button" data-action="admin-do-create-customer">创建</button></div></div>`;
  }

  private adminEditCustomerModalHtml() {
    return `<div class="modal-card admin-modal"><button class="modal-close" data-action="close-modal">×</button><span class="eyebrow">编辑客户</span><h2>修改姓名</h2>
      <label class="login-field"><span>客户姓名</span><input id="admin-form-customer-name" value="${escapeHtml(this.adminFormCustomerName)}" placeholder="请输入客户姓名" /></label>
      <div class="modal-actions"><button class="quiet-button" data-action="close-modal">取消</button><button class="primary-button" data-action="admin-do-edit-customer">保存</button></div></div>`;
  }

  private settingsModalHtml() {
    return `<div class="modal-card settings-modal"><button class="modal-close" data-action="close-modal">×</button><span class="eyebrow">连接设置</span><h2>pi-agent 配置</h2>${this.settingsHtml()}</div>`;
  }

  private renderToast() {
    const toastRoot = this.container.querySelector("#toast-root");
    if (toastRoot) toastRoot.innerHTML = this.toastHtml();
  }
}

new FinanceAdvisorApp(root);