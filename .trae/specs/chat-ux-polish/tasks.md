# Tasks

## Task 1: 前端依赖与渲染基础工具
- [x] 1.1 `web/package.json` 新增 `marked` 依赖并安装（pnpm）
- [x] 1.2 新增 `web/src/markdown.ts`：封装 `renderMarkdown(text)`（gfm+breaks，解析前 `escapeHtml` 防 XSS），供气泡文本渲染复用
- [x] 1.3 `result-parser.ts` 新增 `stripJsonFence(text)`：移除文本中 ```json 代码块（含围栏），供卡片渲染时清理气泡文本
- 验证：`vite build`（web）通过；`renderMarkdown`/`stripJsonFence` 有 vitest 单测（5 个用例通过）

## Task 2: 流式过程极简指示
- [x] 2.1 `web/src/main.ts` `sendMessage` 回调：`onThinking`/`onToolCall` 统一置 `toolStatus = "AI 正在处理…"`，不再显示工具名/思考细节
- [x] 2.2 `chatListHtml` 保留 `chat-tool-status` 渲染；确认 `toolStatus` 在 final 到达/流式文本开始后被清空（现有 finally 逻辑）
- 验证：`vite build` 通过；Grep 确认无"正在思考/正在调用"细节文案残留

## Task 3: 气泡内方案卡片 + JSON 源码剥离
- [x] 3.1 `chatListHtml` 助手气泡：`msg.plans` 存在时渲染 `planCardHtml` 完整卡片（复用，含操作按钮）
- [x] 3.2 助手气泡文本：渲染前对 `msg.text` 调用 `stripJsonFence`；卡片存在时确保 JSON 源码块不露出
- [x] 3.3 确认卡片内 `view-detail`/`accept-plan`/`confirm` 按钮的全局事件处理仍生效（与右侧联动）
- 验证：`vite build` 通过；Grep 确认 `renderMarkdown(stripJsonFence(msg.text))` 接入

## Task 4: Markdown 渲染接入
- [x] 4.1 `chatListHtml` 助手气泡文本改用 `renderMarkdown(msg.text)`（流式期间实时渲染，光标追加在渲染结果后）
- [x] 4.2 用户气泡保持纯文本（不渲染 md）
- 验证：`vite build` 通过；`renderMarkdown` 单测覆盖标题/加粗/表格/HTML 转义

## Task 5: 用户气泡头像方位修复
- [x] 5.1 `chatListHtml` 用户消息 DOM 顺序调整（`flex-direction: row-reverse` 下 avatar 前置），使头像落在气泡右侧
- [x] 5.2 确认助手消息头像在左侧（现状不变）；无相关 CSS 回退
- 验证：`vite build` 通过；Grep 确认用户消息 avatar 在 copy 之前

## Task 6: 后端历史会话一问一答聚合
- [x] 6.1 `pi-gateway/src/session-aggregate.ts` 新增 `aggregateSessionEntries`；`agent-session.ts` 的 `getSessionMessages` 改为读取全部 jsonl 后聚合（user 消息起始，其后的 assistant/toolResult 合并为 1 条 assistant）
- [x] 6.2 用户消息剥离 `[会话上下文] xxx` 前缀行（`stripContextPrefix`）
- [x] 6.3 工具消息（role=toolResult）不单独成气泡；文本含 GenerateResult JSON 时解析为 `plans` 附加到对应 assistant 消息
- [x] 6.4 assistant 回答 = 该轮所有 assistant 文本合并；附带 `plans` 时文本中 JSON 源码块移除
- [x] 6.5 `SessionMessage` 接口新增可选 `plans?: unknown`；`listSessions.lastMessage` 剥离前缀
- 验证：`vitest run`（pi-gateway）43 个用例全部通过；`session-aggregate.test.ts` 10 个聚合用例覆盖

## Task 7: 类型与前端历史还原
- [x] 7.1 `web/src/types.ts`：`GatewaySessionMessage` 新增可选 `plans?: GenerateResult`
- [x] 7.2 `web/src/main.ts` `loadSessionChat`：优先采用接口返回的 `plans` 还原方案卡片；文本渲染与 live 一致（md + 卡片 + JSON 剥离）
- 验证：`tsc --noEmit` / `vite build` 通过

## Task 8: 全量验证与收尾
- [x] 8.1 全量验证：pi-gateway `npm run test`（43 通过）+ `npm run build`（tsc）通过；web `npm run test`（7 通过）+ `npm run build`（vite）通过
- [x] 8.2 浏览器 UI 验证项汇总（留待用户自测：流式指示、卡片内嵌、头像方位、历史问答聚合）
- 验证：所有命令通过；checklist 全绿

# Task Dependencies
- Task 2/3/4/5 依赖 Task 1（基础工具与依赖）
- Task 7 依赖 Task 6（后端聚合协议）与 Task 3/4（前端渲染）
- Task 8 依赖全部前置任务
