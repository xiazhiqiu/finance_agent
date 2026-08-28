# 历史会话名称编辑 Spec

## Why
历史会话卡标题目前展示 pi-gateway 首条用户消息（或后端占位名「2026-08-14 对话」），无法表达会话主题、也不能自定义。需要支持：默认标题统一为「客户名 - 营销会话 - YYYYMMDD」，并允许在历史列表卡上编辑标题（持久化）。标题是纯展示元数据，不参与任何业务逻辑（会话 ID / plans / 采纳 / 成交均与其无关），但需要持久化存储。

## What Changes
- 前端新建会话时传入默认标题 `客户名 - 营销会话 - YYYYMMDD`（日期取会话 `createdAt`），写入后端 `PlanSession.title`。
- 会话卡标题展示从 `gatewaySessionFor(s).title || s.title` 改为「标题显示优先级」：编辑过 / 新默认格式优先；命中旧占位名（`^\d{4}-\d{2}-\d{2} 对话$`）或为空时前端实时计算新默认名。pi-gateway 首条用户消息标题（`gw.title`）不再作为会话名展示。
- 历史列表卡（非当前会话）标题旁增加铅笔图标 → 行内 `<input>` 编辑 → 调用现有 `updateSession(sessionId, { title })` 持久化，本地列表即时刷新。
- 校验规则：空 / 全空白回退默认名（不写空值）；长度上限 30 字符，超长截断。
- 新增纯函数模块 `session-title.ts`（默认名生成 / 旧占位名判定）及单测，遵循现有 `result-parser.ts` 独立纯模块 + 测试的代码库惯例。
- 后端与 API 层无需改动（`title` 字段与更新白名单均已支持）。

## Impact
- Affected specs: `chat-conversation-unify`（历史会话卡）、`fix-chat-review-issues`（标题=首条指令）
- Affected code:
  - `finclaw/web/src/main.ts`（新建会话传默认名、`sessionCardHtml` 显示逻辑、铅笔图标 + 行内编辑）
  - `finclaw/web/src/styles.css`（铅笔图标、行内编辑框样式）
  - `finclaw/web/src/session-title.ts`（新增，纯函数）
  - `finclaw/web/src/session-title.test.ts`（新增，单测）

## ADDED Requirements
### Requirement: 默认会话标题
系统 SHALL 在新建会话时以前端生成的默认标题「客户名 - 营销会话 - YYYYMMDD」持久化（日期取会话 `createdAt`，格式 `YYYYMMDD`，如 `20260814`）。

#### Scenario: 新建会话默认命名
- **WHEN** 用户触发新建会话（历史会话 Tab「新建会话」按钮 / 批量方案生成等所有 `createSession` 入口）
- **THEN** 新会话标题为 `客户名 - 营销会话 - YYYYMMDD` 并持久化到后端

### Requirement: 会话标题编辑
系统 SHALL 允许用户在历史列表卡（非当前会话）上编辑会话标题并持久化。

#### Scenario: 编辑标题
- **WHEN** 用户点击非当前会话卡的铅笔图标
- **THEN** 标题转为行内 `<input>` 并聚焦全选
- **WHEN** 用户回车或失焦
- **THEN** 标题更新并持久化，列表即时刷新
- **WHEN** 用户按 Esc
- **THEN** 取消编辑，标题保持不变
- **WHEN** 新标题为空或全空白
- **THEN** 回退显示默认标题，不向后端写空值
- **WHEN** 新标题超过 30 字符
- **THEN** 截断为 30 字符保存

### Requirement: 标题显示优先级
系统 SHALL 按以下顺序决定会话卡展示标题：编辑过 / 新默认格式标题 → 旧占位名或为空时实时计算默认名。不再使用 pi-gateway 首条用户消息标题。

#### Scenario: 旧会话显示
- **WHEN** 会话 `title` 匹配旧占位名 `^\d{4}-\d{2}-\d{2} 对话$` 或为空
- **THEN** 显示实时计算的默认标题 `客户名 - 营销会话 - YYYYMMDD`（日期取 `createdAt`）
- **WHEN** 会话 `title` 为自定义名或新默认格式
- **THEN** 原样显示该标题

## MODIFIED Requirements
### Requirement: 历史会话卡片展示（原 chat-conversation-unify）
标题展示从 `gatewaySessionFor(s).title || s.title` 改为「标题显示优先级」；其余（最后消息预览 / 消息条数 / 方案数 / 时间 / 切换 / 删除 / 新建）保持不变。当前会话卡只读，不显示编辑入口。

## REMOVED Requirements
### Requirement: 首条用户消息作为会话标题（原 fix-chat-review-issues）
**Reason**: 会话标题改为纯展示元数据，默认模式统一为「客户名 - 营销会话 - 日期」，首条用户消息不再作为会话名。
**Migration**: 旧会话标题在展示层按旧占位名规则回退为默认名；用户编辑后持久化为自定义名。
