# Tasks

> 实施顺序遵循"先后端存储/纯逻辑 → 再后端 API → 再 pi-gateway 编排 → 再前端 API/UI → 最后集成验证"。后端与前端可并行推进的环节已标注。

## 后端（finclaw/backend/src）

- [x] Task 1: 画像快照哈希存储与对比（store.mjs）
  - [x] SubTask 1.1: 在 store.mjs 新增画像哈希持久化（复用 runtimeDir 下新文件 `customer_profile_hashes.json`，结构 `{ [customerId]: { hash, updatedAt } }`）
  - [x] SubTask 1.2: 实现 `getProfileHash(customerId)` 与 `setProfileHash(customerId, hash)` 读写函数
  - [x] SubTask 1.3: 实现 `computeProfileHash(customer)` 纯函数：对画像字段做稳定 JSON 序列化（键排序）+ SHA-256，返回 hex 字符串
  - [x] SubTask 1.4: 实现 `hasProfileChanged(customerId, customer)`：返回 `true`（无记录或哈希不同）或 `false`（哈希相同）

- [x] Task 2: 洞察防重复查询（store.mjs）
  - [x] SubTask 2.1: 新增 `getLatestInsightStatusForCustomer(customerId)`：返回该客户最新一条洞察的 status（pending/confirmed/rejected），无则返回 null
  - [x] SubTask 2.2: 在 `addInsight` 成功后，连带更新该客户画像哈希（记录本次洞察对应的画像快照）
  - [x] SubTask 2.3: `confirmInsight` / `rejectInsight` 不改变画像哈希（仅状态变更）

- [x] Task 3: 批量洞察按目标客户过滤（scheduler.mjs）
  - [x] SubTask 3.1: 修改 `triggerBatchInsight(managerId, { customerIds, onlyChanged })`：支持传入选定客户，缺省取该经理名下全部客户
  - [x] SubTask 3.2: 在 `runBatchInsightStage` 内对每个客户应用过滤：`hasPendingInsight` → 跳过；`!onlyChanged && hasConfirmedProfileUnchanged` → 跳过；`onlyChanged && !hasProfileChanged` → 跳过
  - [x] SubTask 3.3: 跳过客户计入 `failed` 之外的独立 `skipped` 计数，并在返回结果中记录跳过原因（pending/unchanged）
  - [x] SubTask 3.4: 仅对通过过滤的客户调用规则层 `evaluateCustomers` 与 pi-gateway LLM 洞察

- [x] Task 4: 后端 API 扩展（server.mjs）
  - [x] SubTask 4.1: 修改 `POST /api/batch/insight` 读取 body 的 `customerIds`（可选）与 `onlyChanged`（可选，默认 true）
  - [x] SubTask 4.2: 透传上述参数给 `triggerBatchInsight`，返回结构含 `skipped` 明细
  - [x] SubTask 4.3: 确认 `/api/customers` 的 `hasInsight` 筛选已存在（用于提醒栏标签筛选，无需改动）

## pi-gateway（finclaw/pi-gateway/src）

- [x] Task 5: 批量洞察编排支持目标客户（insight-orchestrator.ts）
  - [x] SubTask 5.1: 确认 `runBatchInsight` 已按 `req.customerIds` 遍历（无需改动核心逻辑）
  - [x] SubTask 5.2: 确认 scheduler 传入的 `customerIds` 已为过滤后的目标客户（后端已完成过滤）

## 前端（finclaw/web/src）

- [x] Task 6: API 层扩展（api.ts）
  - [x] SubTask 6.1: 修改 `triggerBatchInsight(customerIds?, onlyChanged?)`：POST body 带可选 `customerIds` 与 `onlyChanged`
  - [x] SubTask 6.2: 更新 `BatchInsightResult` 类型以包含 `skipped`（见 types.ts）

- [x] Task 7: 类型定义（types.ts）
  - [x] SubTask 7.1: 扩展 `BatchInsightResult`：新增 `skipped: { total: number; details: Array<{ customerId: string; reason: string }> }`
  - [x] SubTask 7.2: 新增 `triggerBatchInsight` 请求参数类型（复用 `EditCustomerProfileRequest` 无关，单独定义）

- [x] Task 8: 客户中心交互重构（main.ts）
  - [x] SubTask 8.1: 将工具栏的"批量"与"多选"按钮合并为单个"批量操作"按钮（`data-action="toggle-multi-select"`）
  - [x] SubTask 8.2: 多选栏操作按钮改名为"客户洞察"（`batch-insight`）与"方案生成"（`batch-plans`）
  - [x] SubTask 8.3: 多选栏新增"仅分析画像有变动的客户"开关（`onlyChanged` 复选，默认勾选）
  - [x] SubTask 8.4: `doBatchInsight` 改为使用 `selectedCustomerIds` + `onlyChanged` 调用 API；无选中客户时禁用
  - [x] SubTask 8.5: 批量洞察完成后刷新提醒区与客户列表（含 skipped 提示 toast）

- [x] Task 9: 提醒栏标签筛选修复（main.ts）
  - [x] SubTask 9.1: 修改 `matchReminderFilter("insight")`：改为基于客户是否存在 pending 洞察（结合 `listCustomers({ hasInsight: true })` 或客户列表已含的 pending 洞察信息）
  - [x] SubTask 9.2: 确保 `renderCustomerList` 在提醒栏筛选激活时正确过滤

## 集成验证

- [x] Task 10: 端到端验证
  - [x] SubTask 10.1: `.\scripts\start.ps1` 全栈启动正常（在 finclaw 目录执行）
  - [x] SubTask 10.2: 浏览器验证"批量操作"按钮进入多选模式，操作按钮显示"客户洞察"/"方案生成"
  - [x] SubTask 10.3: 浏览器验证选定客户执行"客户洞察"，仅画像变动客户被处理，skipped 提示正确
  - [x] SubTask 10.4: 浏览器验证有 pending 洞察的客户被跳过（不重复生成）
  - [x] SubTask 10.5: 浏览器验证"仅分析画像有变动的客户"开关开/关行为
  - [x] SubTask 10.6: 浏览器验证提醒栏"待确认洞察"标签点击后仅显示有 pending 洞察的客户
  - [x] SubTask 10.7: 浏览器验证"方案生成"对选定客户正常执行

# Task Dependencies

- [Task 2] 依赖 [Task 1]（防重复查询依赖画像哈希）
- [Task 3] 依赖 [Task 1] + [Task 2]
- [Task 4] 依赖 [Task 3]
- [Task 5] 依赖 [Task 3]（scheduler 过滤后传入目标客户）
- [Task 6] 依赖 [Task 7]（API 类型先行）
- [Task 8] 依赖 [Task 6]（前端调用新 API 签名）
- [Task 9] 依赖 [Task 8]（复用客户列表渲染）
- [Task 10] 依赖 [Task 1]-[Task 9] 全部完成

# Suggested Commit Granularity

本任务完成后暂不提交（用户要求测试验收后先不提交）。若需提交，按后端 → pi-gateway → 前端 → 验证 分 4 次提交。