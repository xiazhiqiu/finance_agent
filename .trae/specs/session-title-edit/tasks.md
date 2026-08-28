# Tasks

- [x] Task 1: 创建 `session-title.ts` 纯函数模块，实现 `defaultSessionTitle(customerName, createdAt)` 和 `isOldPlaceholderTitle(title)` 两个函数
  - `defaultSessionTitle`: 返回 `客户名 - 营销会话 - YYYYMMDD`（日期从 `createdAt` 提取，格式 `YYYYMMDD`）
  - `isOldPlaceholderTitle`: 匹配旧占位名 `^\d{4}-\d{2}-\d{2} 对话$`
- [x] Task 2: 创建 `session-title.test.ts` 单元测试，覆盖以下场景
  - 默认标题生成：正常客户名 + 日期生成正确格式
  - 旧占位名判定：匹配和不匹配的情况
  - 边界情况：空客户名、空日期
- [x] Task 3: 修改 `main.ts` 中 `startNewSession` 方法，在调用 `createSession` 时传入默认标题 `this.customer.name - 营销会话 - YYYYMMDD`
  - 从新会话的 `createdAt` 提取日期，格式 `YYYYMMDD`
  - 因为 `createSession` 返回后才拿到 `createdAt`，需要先创建再 `updateSession` 设置标题，或在创建时同步计算日期（当前时间）
- [x] Task 4: 修改 `main.ts` 中 `sessionCardHtml` 方法，实现标题显示优先级逻辑
  - 标题显示优先级：自定义标题 → 新默认格式标题 → 旧占位名或空时实时计算默认名
  - 不再使用 `gw.title`（pi-gateway 首条用户消息）作为会话名
  - 当前会话卡只读，不显示编辑入口
  - 非当前会话卡标题旁增加铅笔图标
- [x] Task 5: 实现会话标题行内编辑交互
  - 点击铅笔图标 → 标题转为 `<input>` 并聚焦全选
  - 回车/失焦 → 调用 `updateSession(sessionId, { title })` 持久化，本地列表即时刷新
  - Esc → 取消编辑，标题保持不变
  - 空/全空白 → 回退默认名，不写空值
  - 超 30 字符 → 截断保存
- [x] Task 6: 更新 `styles.css`，添加铅笔图标和行内编辑框样式
- [x] Task 7: 运行全部测试（`pnpm test`）和构建（`tsc`、`vite build`）验证

# Task Dependencies
- Task 2 依赖 Task 1
- Task 3/4 依赖 Task 1
- Task 5 依赖 Task 4
- Task 6 可并行于 Task 3/4/5
- Task 7 依赖所有前置任务