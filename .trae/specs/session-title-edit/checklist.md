# Checklist

- [x] `session-title.ts` 模块存在，导出 `defaultSessionTitle()` 和 `isOldPlaceholderTitle()` 两个纯函数
- [x] `defaultSessionTitle("张三", "2026-08-14T...")` 返回 `"张三 - 营销会话 - 20260814"`
- [x] `isOldPlaceholderTitle("2026-08-14 对话")` 返回 `true`
- [x] `isOldPlaceholderTitle("张三 - 营销会话 - 20260814")` 返回 `false`
- [x] `session-title.test.ts` 包含对上述函数的全面测试（正常、边界、异常）
- [x] `pnpm test` 所有测试通过（含新测试和已有测试，14/14）
- [x] `startNewSession` 在创建会话时传入默认标题
- [x] `sessionCardHtml` 标题展示按优先级：自定义/新默认 → 旧占位名回退默认名
- [x] 当前会话卡不显示铅笔图标（只读），非当前会话卡显示铅笔图标
- [x] 点击铅笔图标 → 标题变为 `<input>` 并聚焦全选
- [x] 回车/失焦 → 保存新标题，列表即时刷新
- [x] Esc → 取消编辑，标题不变
- [x] 空/全空白 → 回退默认名，不写空值
- [x] 超 30 字符 → 截断为 30 字符保存
- [x] `styles.css` 包含铅笔图标和行内编辑输入框样式
- [x] `tsc` 编译无错误
- [x] `vite build` 构建成功