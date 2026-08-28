# 洞察功能一键增量优化 Spec

## Why

当前"批量规则洞察"每次点击都会对所有客户执行全量洞察，且对同一客户重复生成并记录洞察，产生大量冗余 LLM 调用与洞察记录。同时提醒栏"待确认洞察"标签的筛选逻辑错误（误用画像标签而非洞察状态），无法按待确认洞察快捷筛选客户。需要让洞察变为"一键且只针对画像有变动的客户"，阻塞有未确认洞察的客户，并修复提醒栏标签筛选。

## What Changes

- 后端画像快照哈希检测：为每个客户记录画像哈希，仅对画像有变动的客户执行洞察。
- 洞察防重复：有 `confirmed` 洞察且画像未变 → 跳过；有 `pending` 洞察 → 跳过该客户（不阻塞其他客户）；有 `rejected` 洞察 → 重新洞察。
- 前端客户中心交互重构：搜索框旁的"批量"与"多选"按钮合并为单个"批量操作"按钮；点击进入多选模式；多选栏操作按钮命名为 **"客户洞察"** 与 **"方案生成"**（去掉"批量"字样）；提供"仅分析画像有变动的客户"开关。
- 一键全量洞察快捷入口移除（merge 进多选模式）。
- 提醒栏"待确认洞察"标签筛选逻辑修复：按客户是否存在 `status=pending` 洞察筛选，而非画像标签。

## Impact

- Affected specs: 洞察编排（M2/M4）、提醒区汇总（M3.5）、批量任务（M0/M3）
- Affected code:
  - `finclaw/backend/src/store.mjs`（新增画像哈希存储/对比、洞察防重复查询）
  - `finclaw/backend/src/scheduler.mjs`（批量洞察阶段按变动客户过滤）
  - `finclaw/backend/src/server.mjs`（`/api/batch/insight` 支持前端传入已选客户 + 仅变动开关；提醒区/insights 查询；`/api/customers` hasInsight 已存在无需改）
  - `finclaw/pi-gateway/src/workflow/insight-orchestrator.ts`（批量洞察只处理传入的目标客户）
  - `finclaw/web/src/api.ts`（`triggerBatchInsight` 支持选定客户与仅变动开关）
  - `finclaw/web/src/main.ts`（客户中心按钮合并、多选栏操作按钮改名、提醒栏筛选修复）
  - `finclaw/web/src/types.ts`（批次洞察请求参数类型）

## ADDED Requirements

### Requirement: 画像变动检测
系统 SHALL 为每个客户记录画像快照哈希（对画像核心/全部字段做稳定序列化 + 哈希），并在批量洞察前对比当前画像哈希与上次记录的值。

#### Scenario: 画像有变动
- **WHEN** 客户画像任一字段发生变化后执行批量洞察
- **THEN** 该客户被纳入洞察目标；洞察完成后更新其画像哈希

#### Scenario: 画像无变动
- **WHEN** 客户画像无变动且已存在 confirmed 洞察
- **THEN** 该客户被跳过，不调用 LLM、不新增洞察记录

### Requirement: 防重复洞察
批量洞察 SHALL 跳过有下列情况的客户：存在 `status=pending` 洞察（未确认/未驳回）；存在 `status=confirmed` 洞察且画像未变动。存在 `status=rejected` 洞察的客户 SHALL 重新洞察。

#### Scenario: 有未确认洞察
- **WHEN** 客户存在 pending 洞察
- **THEN** 跳过该客户，不影响其他客户，结果中记录跳过原因

#### Scenario: 有已驳回洞察
- **WHEN** 客户存在 rejected 洞察
- **THEN** 无论画像是否变动，都重新生成洞察

### Requirement: 客户中心批量操作合并
前端 SHALL 将搜索框旁的"批量"与"多选"按钮合并为单个"批量操作"按钮；点击进入多选模式；多选栏提供"客户洞察"与"方案生成"两个操作按钮（去掉"批量"字样），并提供"仅分析画像有变动的客户"开关。

#### Scenario: 进入多选模式
- **WHEN** 用户点击"批量操作"
- **THEN** 进入多选模式，显示多选栏，含已选计数、全选/反选、退出，以及"客户洞察""方案生成"操作按钮

#### Scenario: 执行客户洞察
- **WHEN** 用户勾选客户后点击"客户洞察"
- **THEN** 对所选客户执行批量洞察（受"仅分析画像有变动的客户"开关约束），完成后刷新提醒区

#### Scenario: 执行方案生成
- **WHEN** 用户勾选客户后点击"方案生成"
- **THEN** 对所选客户执行批量方案生成

### Requirement: 提醒栏待确认洞察标签快捷筛选
提醒栏"待确认洞察"标签的筛选逻辑 SHALL 基于客户是否存在 `status=pending` 洞察，而非画像标签。

#### Scenario: 点击待确认洞察标签
- **WHEN** 用户点击提醒栏"待确认洞察"标签
- **THEN** 客户列表仅显示存在 pending 洞察的客户

## MODIFIED Requirements

### Requirement: 批量洞察入口
原 `/api/batch/insight` 全量洞察 SHALL 扩展为支持传入 `customerIds`（选定客户）与 `onlyChanged`（仅画像变动的客户）参数；未传 `customerIds` 时默认取该经理名下全部客户。

### Requirement: 一键全量洞察移除
原独立"批量"按钮（一键全量洞察）从客户中心移除，其能力并入多选模式的"客户洞察"操作。

## REMOVED Requirements

### Requirement: 一键全量洞察快捷按钮
**Reason**: 与多选模式的"客户洞察"操作重复，且与"仅针对画像有变动客户"的优化目标冲突。
**Migration**: 用户通过"批量操作" → 多选 → "客户洞察"完成相同目标。