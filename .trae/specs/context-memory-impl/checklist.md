# Checklist

- [x] context-builder.ts 存在且 projectPlanContext 剔除 strategies、products 仅含 6 个白名单字段
- [x] serializeLeafContext 输出无缩进紧凑 JSON，超预算时先裁剪 knowledge/marketBrief，并输出估算 token 日志
- [x] fetchContext 支持 scope：customer 只发 1 个请求；plan 并发拉画像/产品/知识库/市场简报且不再请求 strategies
- [x] workflow/backend-client.ts 不再含私有 loadConfig/buildHeaders/request，复用 tools/backend-http.ts（含新增 backendPost/backendPut）
- [x] llm-leaf buildPrompt 注入的上下文为投影后紧凑 JSON（无 null,2 缩进）
- [x] backend customer_summaries.json 读写 + GET/PUT /api/customers/:id/summary 可用，覆盖式更新（冒烟 200，updatedAt 强制）
- [x] 网关按 FINANCE_SUMMARY_REFRESH_MS（默认 10 分钟）节流刷新客户摘要，失败不影响主对话（冒烟：对话后 LLM 自动生成结构化摘要并落盘）
- [x] 主对话会话创建时经 appendSystemPromptOverride 注入稳定前缀；runPrompt 消息不再带 [会话上下文] 前缀；backend 不可达时降级不阻塞（冒烟：回答引用画像/摘要/市场简报，SSE 流无前缀）
- [x] 稳定前缀的画像经白名单 pick，不包含团队新增的 tasks/合并 tags 字段
- [x] backend GET/PUT /api/market/brief 可用；plan scope marketBrief 注入；market_query 工具注册且 .pi/AGENTS.md 已更新（冒烟：market_query 返回简报内容）
- [x] .pi/settings.json compaction.enabled=true；compaction_start/end 有日志；POST /api/sessions/:sessionKey/compact 返回压缩结果（冒烟：200 + CompactionResult；过小会话 400 业务错误分支亦验证）
- [x] product_query 回灌不含 minAmount/campaigns
- [x] message_end 携带 usage 时输出日志（无 usage 不报错）（冒烟：usage 日志含 cacheRead，稳定前缀缓存命中 6272+）
- [x] data-dictionary.md / api-reference.md 已同步新增数据文件、端点、协议与环境变量
- [x] 未触碰 scheduler.mjs 洞察链路与 mergeTasksForCustomer（与团队洞察工作流解耦约束一致）（git diff 确认无改动）
- [x] pnpm --filter pi-gateway test 全绿（8 文件 66 用例），tsc --noEmit 无错误
- [x] 冒烟通过：主对话、方案生成（3 套方案+合规报告 17s）、摘要落盘、market_query、compact 端点
