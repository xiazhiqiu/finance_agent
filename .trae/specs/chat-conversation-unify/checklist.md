# Checklist

- [x] 右栏渲染为多轮对话界面，手动输入与快捷按键触发均以"头像+气泡"交替记录
- [x] 快捷按键点击插入用户气泡并自动发送指令，不再直接执行生成逻辑
- [x] 所有消息经 Pi SDK `AgentSession`；"把方案A的权益比例降低到 20%" 类指代可从会话上下文正确响应
- [x] `generate_plan` / `optimize_plan` 工具存在并返回 `GenerateResult`；携带 `context` 时不重拉数据，未携带时完整跑 workflow
- [x] 前端监听 SSE `tool_result` 渲染 Agent 气泡内方案卡片，保留对比/选择/详情/发送交互
- [x] 会话模型统一：PlanSession 含 `sessionKey` 字段，sessionKey 按会话生成，Pi SDK 会话按会话隔离
- [x] pi-gateway 提供 `GET /api/sessions` 与 `GET /api/sessions/{id}/messages`，返回该会话历史消息
- [x] 刷新后从历史会话列表点击进入可回看完整对话气泡与方案卡片
- [x] 历史会话列表显示 标题/最后消息预览/消息条数/方案数/时间，保留 切换/删除/新建
- [x] 切换客户自动继续该客户最新会话对话；无历史则空白对话；首次发送惰性创建会话
- [x] 既有测试通过（`node --test` / `vitest run` / `tsc` / `vite build`）
