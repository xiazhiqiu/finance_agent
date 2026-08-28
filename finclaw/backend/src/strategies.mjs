/**
 * 营销策略规则层（M0/M3.1）
 *
 * 12 项营销策略，全部为确定性代码规则。
 * 每项策略接收客户画像 + 配置，输出 Task 对象。
 * Task 输出契约：{ taskId, customerId, strategyType, strategyName, status, source, priority, triggerCondition, createdAt }
 *
 * 三层来源中的"规则层"：直写基础任务到 tasks[]（source: 'rule'）。
 * LLM 洞察层在 pi-gateway/insight-orchestrator.ts 中实现，产出待确认洞察。
 */

// ========== 默认配置 ==========

const DEFAULT_CONFIG = {
  today: new Date(),
  maturityDays: 90,           // 到期提醒窗口
  dormantDays: 90,            // 沉睡客户阈值
  riskAssessmentExpiryDays: 365, // 风险测评有效期
  largeAmountThreshold: 500000,  // 大额资金阈值
  upgradeThresholds: {        // 分段升级 AUM 临界值
    "成长客户": 3000000,
    "财富客户": 5000000,
    "私行客户": 8000000,
  },
  downgradeRatio: 0.85,       // AUM 较分段下限下降 15% 触发降级预警
  holidayCalendar: [
    { date: "2026-02-17", name: "春节" },
    { date: "2026-09-25", name: "中秋" },
    { date: "2026-10-01", name: "国庆" },
  ],
  birthdayWindowDays: 7,      // 生日提醒提前天数
};

// ========== 策略定义 ==========

export const STRATEGIES = [
  // ① 资产事件
  { id: "maturity", name: "产品到期承接", category: "资产事件", priority: 100 },
  { id: "risk_assessment_expired", name: "风险评估到期", category: "资产事件", priority: 90 },
  { id: "large_transaction", name: "大额资金异动", category: "资产事件", priority: 85 },
  { id: "upgrade_warning", name: "临界客户升级预警", category: "资产事件", priority: 70 },
  { id: "downgrade_warning", name: "资产降级预警", category: "资产事件", priority: 75 },
  // ② 关系关怀
  { id: "birthday", name: "生日祝福营销", category: "关系关怀", priority: 60 },
  { id: "dormant", name: "沉睡客户唤醒", category: "关系关怀", priority: 50 },
  { id: "holiday", name: "节日问候", category: "关系关怀", priority: 40 },
  // ③ 生命周期
  { id: "retirement", name: "退休养老规划", category: "生命周期", priority: 55 },
  { id: "education_fund", name: "子女教育金规划", category: "生命周期", priority: 55 },
  { id: "wealth_succession", name: "财富传承规划", category: "生命周期", priority: 55 },
  // 补充：新客破冰（暂缓项，预留）
  { id: "account_review", name: "账户定期检视", category: "资产事件", priority: 45 },
];

// ========== 工具函数 ==========

function daysBetween(from, to) {
  const ms = new Date(to).getTime() - new Date(from).getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

function makeTask(customer, strategy, triggerCondition) {
  return {
    taskId: `${strategy.id}_${customer.customerId}_${Date.now()}`,
    customerId: customer.customerId,
    strategyType: strategy.id,
    strategyName: strategy.name,
    category: strategy.category,
    status: "pending",
    source: "rule",
    priority: strategy.priority,
    triggerCondition,
    createdAt: new Date().toISOString(),
  };
}

// ========== 逐策略评估函数 ==========

// 1. 产品到期承接：upcomingMaturities 中 dueDate 在 N 天内
function evalMaturity(customer, config) {
  const tasks = [];
  if (!Array.isArray(customer.upcomingMaturities)) return tasks;
  for (const m of customer.upcomingMaturities) {
    if (!m.dueDate) continue;
    const days = daysBetween(config.today, m.dueDate);
    if (days >= 0 && days <= config.maturityDays) {
      tasks.push(makeTask(customer, STRATEGIES[0],
        `${m.productType} ¥${m.amount.toLocaleString()} 将于 ${m.dueDate} 到期（${days} 天后）`));
    }
  }
  return tasks;
}

// 2. 风险评估到期：riskAssessmentDate 超过 1 年或为空
function evalRiskAssessment(customer, config) {
  if (!customer.riskAssessmentDate) {
    return [makeTask(customer, STRATEGIES[1], "客户未完成风险评估，需立即评估")];
  }
  const days = daysBetween(customer.riskAssessmentDate, config.today);
  if (days > config.riskAssessmentExpiryDays) {
    return [makeTask(customer, STRATEGIES[1], `风险测评已过期 ${days - config.riskAssessmentExpiryDays} 天`)];
  }
  return [];
}

// 3. 大额资金异动：recentTransactions 含大额关键词或金额阈值
function evalLargeTransaction(customer, config) {
  const text = customer.recentTransactions || "";
  const keywords = ["大额", "赎回", "转入", "结汇", "追加", "奖金"];
  const hasKeyword = keywords.some((k) => text.includes(k));
  // 检查交易文本中是否包含大额数字
  const amounts = text.match(/[\d,]+万|[\d,]{6,}/g);
  const hasLargeAmount = amounts && amounts.some((a) => {
    const num = parseFloat(a.replace(/[万,]/g, "")) * (a.includes("万") ? 10000 : 1);
    return num >= config.largeAmountThreshold;
  });
  if (hasKeyword || hasLargeAmount) {
    return [makeTask(customer, STRATEGIES[2], `近期交易存在大额资金异动：${text.slice(0, 40)}`)];
  }
  return [];
}

// 4. 临界客户升级预警：aum 接近下一分段临界值（95% 以上）
function evalUpgradeWarning(customer, config) {
  const segment = customer.segment;
  const thresholds = config.upgradeThresholds;
  const order = ["成长客户", "财富客户", "私行客户"];
  const idx = order.indexOf(segment);
  if (idx < 0 || idx >= order.length - 1) return []; // 最高段无升级
  const nextSegment = order[idx + 1];
  const threshold = thresholds[nextSegment];
  if (!threshold) return [];
  const ratio = customer.aum / threshold;
  if (ratio >= 0.95 && ratio < 1.0) {
    return [makeTask(customer, STRATEGIES[3],
      `AUM ¥${customer.aum.toLocaleString()} 接近 ${nextSegment} 临界值 ¥${threshold.toLocaleString()}（${(ratio * 100).toFixed(1)}%）`)];
  }
  return [];
}

// 5. 资产降级预警：aum 较当前分段下限下降 15%
function evalDowngradeWarning(customer, config) {
  const segment = customer.segment;
  const thresholds = config.upgradeThresholds;
  const order = ["成长客户", "财富客户", "私行客户"];
  const idx = order.indexOf(segment);
  if (idx <= 0) return []; // 最低段无降级
  const currentThreshold = thresholds[segment];
  if (!currentThreshold) return [];
  if (customer.aum < currentThreshold * config.downgradeRatio) {
    return [makeTask(customer, STRATEGIES[4],
      `AUM ¥${customer.aum.toLocaleString()} 较 ${segment} 下限 ¥${currentThreshold.toLocaleString()} 下降超过 ${Math.round((1 - config.downgradeRatio) * 100)}%`)];
  }
  return [];
}

// 6. 生日祝福营销：birthday 在未来 N 天内
function evalBirthday(customer, config) {
  if (!customer.birthday) return [];
  const today = config.today;
  const birthMonthDay = customer.birthday.slice(5); // MM-DD
  const year = today.getFullYear();
  const birthdayThisYear = new Date(`${year}-${birthMonthDay}`);
  const days = daysBetween(today, birthdayThisYear);
  if (days >= 0 && days <= config.birthdayWindowDays) {
    return [makeTask(customer, STRATEGIES[5],
      days === 0 ? "客户今日生日" : `客户生日将在 ${days} 天后`)];
  }
  return [];
}

// 7. 沉睡客户唤醒：lastContact.date 超过阈值天数
function evalDormant(customer, config) {
  if (!customer.lastContact?.date) {
    return [makeTask(customer, STRATEGIES[6], "客户从未联系，建议尽快触达")];
  }
  const days = daysBetween(customer.lastContact.date, config.today);
  if (days > config.dormantDays) {
    return [makeTask(customer, STRATEGIES[6],
      `客户已 ${days} 天未联系（上次：${customer.lastContact.date}）`)];
  }
  return [];
}

// 8. 节日问候：配置的节日日历，提前 7 天
function evalHoliday(customer, config) {
  const tasks = [];
  for (const holiday of config.holidayCalendar) {
    const days = daysBetween(config.today, holiday.date);
    if (days >= 0 && days <= 7) {
      tasks.push(makeTask(customer, STRATEGIES[7],
        days === 0 ? `${holiday.name}问候` : `${holiday.name}将至（${days} 天后），准备问候`));
    }
  }
  return tasks;
}

// 9. 退休养老规划：lifeCycleStage === '退休期'
function evalRetirement(customer) {
  if (customer.lifeCycleStage === "退休期") {
    return [makeTask(customer, STRATEGIES[8], "客户处于退休期，建议规划养老现金流")];
  }
  return [];
}

// 10. 子女教育金规划：lifeCycleStage === '家庭成长期'
function evalEducationFund(customer) {
  if (customer.lifeCycleStage === "家庭成长期") {
    return [makeTask(customer, STRATEGIES[9], "客户处于家庭成长期，建议规划子女教育金")];
  }
  return [];
}

// 11. 财富传承规划：lifeCycleStage === '财富传承期'
function evalWealthSuccession(customer) {
  if (customer.lifeCycleStage === "财富传承期") {
    return [makeTask(customer, STRATEGIES[10], "客户处于财富传承期，建议规划财富传承方案")];
  }
  return [];
}

// 12. 账户定期检视：无特定条件，所有客户（低优先级）
function evalAccountReview(customer) {
  return [makeTask(customer, STRATEGIES[11], "季度账户定期检视")];
}

// ========== 策略执行器 ==========

const EVALUATORS = [
  evalMaturity, evalRiskAssessment, evalLargeTransaction,
  evalUpgradeWarning, evalDowngradeWarning,
  evalBirthday, evalDormant, evalHoliday,
  evalRetirement, evalEducationFund, evalWealthSuccession,
  evalAccountReview,
];

/**
 * 评估单个客户，返回所有命中策略产生的任务
 * @param {object} customer - 客户画像
 * @param {object} [configOverride] - 配置覆盖
 * @returns {Task[]}
 */
export function evaluateCustomer(customer, configOverride) {
  const config = { ...DEFAULT_CONFIG, ...configOverride };
  const tasks = [];
  for (const evaluator of EVALUATORS) {
    try {
      const result = evaluator(customer, config);
      if (Array.isArray(result)) tasks.push(...result);
    } catch (err) {
      console.error(`[strategies] 评估客户 ${customer.customerId} 策略 ${evaluator.name} 出错:`, err.message);
    }
  }
  return tasks;
}

/**
 * 批量评估多个客户
 * @param {object[]} customers - 客户列表
 * @param {object} [configOverride] - 配置覆盖
 * @returns {{ customerId: string, tasks: Task[] }[]}
 */
export function evaluateCustomers(customers, configOverride) {
  return customers.map((c) => ({
    customerId: c.customerId,
    tasks: evaluateCustomer(c, configOverride),
  }));
}

/**
 * 按策略类型筛选客户（用于 M3.2 任务筛选）
 * @param {object[]} customers - 客户列表
 * @param {string} strategyType - 策略类型 ID
 * @param {object} [configOverride]
 * @returns {string[]} 命中客户的 ID 列表
 */
export function filterCustomersByStrategy(customers, strategyType, configOverride) {
  const config = { ...DEFAULT_CONFIG, ...configOverride };
  return customers
    .filter((c) => evaluateCustomer(c, config).some((t) => t.strategyType === strategyType))
    .map((c) => c.customerId);
}
