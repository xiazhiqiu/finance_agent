# 对话界面体验优化（chat-ux-polish）Spec

## Why
对话界面存在四类体验问题：流式输出中"正在思考…/正在调用 generate_plan…"等思考与工具细节被渲染（违背"细节不做渲染"诉求）；方案生成后气泡内未内嵌媒体卡片，仅以不美观的 md/JSON 源码露出（偏离既有需求）；用户消息头像出现在气泡左侧，不符合主流通话习惯；历史会话被拆分成多条小气泡而非"一问一答"，工具 JSON 摘要直接暴露在界面上。

## What Changes
- 前端：流式期间仅显示极简"AI 正在处理…"指示，移除思考/工具调用细节状态（不显示工具名、thinking 内容、中间 JSON）。
- 前端：方案卡片（复用 `planCardHtml` 完整卡片，含评分/配置比例条/产品组合与操作按钮，点击与右侧"推荐方案"联动）内嵌助手气泡；工具返回的 JSON 不进气泡文本，气泡文本中的 ```json 代码块在卡片渲染时自动剥离。
- 前端：引入 `marked` 对助手文本做 Markdown 渲染（流式实时渲染），标题/加粗/列表/表格正常呈现；解析前对原文做 HTML 实体转义防 XSS。
- 前端：修复用户气泡头像位置——用户消息右对齐、头像在气泡右侧；助手消息左对齐、头像在气泡左侧。
- 后端：`getSessionMessages` 按轮聚合为"一问一答"——每条用户消息与其后到下一条用户消息（或会话结束）之间的全部 assistant/toolResult 消息合并为 1 条 assistant 回答；工具 JSON 摘要不单独成气泡；含可解析 GenerateResult JSON 时还原为 `plans` 数据随答案返回；剥离注入的 `[会话上下文]` 前缀。
- 后端：会话摘要 `listSessions.lastMessage` 同步剥离 `[会话上下文]` 前缀。
- 类型：`GatewaySessionMessage` 新增可选 `plans?: GenerateResult` 字段。

## Impact
- 前端：`web/src/main.ts`（渲染/卡片/处理中指示/头像顺序/JSON 剥离）、`web/src/result-parser.ts`、`web/src/advisor-gateway.ts`、`web/src/types.ts`、`web/src/styles.css`、`web/package.json`（新增 marked 依赖）。
- 后端：`pi-gateway/src/agent-session.ts`（聚合读取、前缀剥离）、`pi-gateway/src/handlers.ts`。
- 既有 spec：`chat-conversation-unify`（对话界面统一）延续性增强，不破坏其会话模型。

## ADDED Requirements

### Requirement: 流式过程极简指示
系统在流式输出期间 SHALL 仅向用户呈现统一的轻量"AI 正在处理…"指示，而不得渲染思考文字、工具名称或中间 JSON。

#### Scenario: 生成方案时的过程呈现
- **WHEN** 用户发送指令且 Agent 正在思考或调用工具
- **THEN** 界面仅显示"AI 正在处理…"小胶囊，无任何工具名/思考细节
- **AND WHEN** 最终答案开始流式输出或方案卡片渲染
- **THEN** 该指示自动消失

### Requirement: 气泡内方案媒体卡片
系统 SHALL 在助手气泡内以现有方案卡片形式内嵌渲染方案数据，且不得在气泡文本中露出工具返回的原始 JSON。

#### Scenario: 方案工具结果渲染
- **WHEN** `generate_plan`/`optimize_plan` 工具返回方案数据
- **THEN** 助手气泡内渲染完整方案卡片（评分/配置比例条/产品组合/操作按钮），按钮点击与右侧"推荐方案"联动
- **AND** 气泡文本中若含 ```json 代码块则被剥离，不展示源码

### Requirement: Markdown 文本渲染
系统 SHALL 对助手文本做 Markdown 渲染，杜绝 md 源码直接露出，并保证 XSS 安全。

#### Scenario: 助手富文本回复
- **WHEN** 助手回复包含 `##` 标题、`**加粗**`、列表或表格
- **THEN** 界面按 Markdown 渲染呈现（流式期间实时渲染）
- **AND** 原文中任何原始 HTML 均被转义，不执行

### Requirement: 用户消息头像方位
系统 SHALL 将用户消息右对齐且头像置于气泡右侧，助手消息左对齐且头像置于气泡左侧。

#### Scenario: 对话气泡布局
- **WHEN** 渲染一条用户消息
- **THEN** 气泡位于右侧、头像位于气泡更外侧（右侧）
- **WHEN** 渲染一条助手消息
- **THEN** 气泡位于左侧、头像位于气泡更外侧（左侧）

### Requirement: 历史会话一问一答聚合
系统 SHALL 在读取历史会话时，将"一条用户消息 + 该轮所有助手/工具消息"聚合为一条用户气泡与一条助手气泡的问答对，隐藏工具内部步骤与 JSON 摘要。

#### Scenario: 读取历史会话
- **WHEN** 用户打开某历史会话
- **THEN** 界面呈现一问一答形式（用户气泡与助手气泡交替）
- **AND** 工具 JSON 摘要、中间步骤不单独成气泡
- **AND** 用户气泡不显示注入的 `[会话上下文]` 前缀
- **AND** 若该轮含可解析的方案 JSON，则助手气泡内还原渲染方案卡片

## MODIFIED Requirements

### Requirement: 会话消息读取接口（`getSessionMessages`）
原实现将 jsonl 中每条 message 平铺返回，导致工具步骤/JSON 摘要被拆分展示。
修改后：返回按轮聚合的 `SessionMessage[]`，每条 assistant 消息携带聚合后的完整文本与可选 `plans`（`GenerateResult`），用户消息剥离 `[会话上下文]` 前缀。

### Requirement: 会话摘要 lastMessage
`listSessions` 的 `lastMessage` 需剥离注入的 `[会话上下文]` 前缀后再作为会话卡片预览。

### Requirement: ChatMessage 渲染逻辑
`chatListHtml` 的助手气泡从 `escapeHtml(msg.text)` 纯文本渲染，改为：Markdown 渲染文本 + 内嵌方案卡片 + 剥离 JSON 源码块；`toolStatus` 仅承载统一"AI 正在处理…"指示。

## REMOVED Requirements

### Requirement: 工具/思考细节状态提示
**Reason**: 用户明确要求"模型思考具体细节信息不做渲染"，且市场主流 Agent UI 不暴露内部推理与工具细节。
**Migration**: 由统一"AI 正在处理…"指示替代；工具执行信息仍保留在后端会话上下文（供 Agent 使用），仅不进入界面。
