# Checklist

## 流式过程呈现
- [x] 流式期间界面仅显示"AI 正在处理…"，无工具名/思考文字/中间 JSON 细节
- [x] 最终答案或方案卡片出现后，"AI 正在处理…"指示消失

## 气泡内方案卡片
- [x] `generate_plan`/`optimize_plan` 返回后，助手气泡内渲染完整方案卡片（评分/配置比例条/产品组合/操作按钮）
- [x] 气泡内卡片操作按钮（选择方案/查看详情/采用方案）点击与右侧"推荐方案"联动
- [x] 气泡文本不再露出 ```json 源码块；工具返回 JSON 不进气泡文本

## Markdown 渲染
- [x] 助手文本的 `##` 标题、`**加粗**`、列表、表格按 Markdown 渲染呈现
- [x] 流式期间实时渲染 Markdown（无整段 md 源码露出）
- [x] 原文中原始 HTML 被转义，不产生 XSS

## 头像方位
- [x] 用户消息右对齐且头像在气泡右侧
- [x] 助手消息左对齐且头像在气泡左侧

## 历史会话聚合
- [x] 历史会话呈现一问一答形式（用户/助手气泡交替），无工具步骤或 JSON 摘要独立成气泡
- [x] 历史用户气泡不显示 `[会话上下文]` 前缀；会话摘要 `lastMessage` 无前缀
- [x] 历史答案含方案 JSON 时还原渲染方案卡片
- [x] 历史答案文本同样按 Markdown 渲染

## 工程验证
- [x] `pi-gateway` 新增 `getSessionMessages` 聚合单测通过（`vitest run`，43/43）
- [x] `web` 新增 `renderMarkdown`/`stripJsonFence` 单测通过（`vitest run`，7/7）
- [x] `tsc` 类型检查通过（pi-gateway build + web `tsc --noEmit`）
- [x] `vite build`（web）通过；新增 `marked` 依赖安装成功
- [x] 浏览器 UI 验证项已汇总（留待用户自测）
