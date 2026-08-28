# Checklist

## 后端
- [x] 画像快照哈希存储函数 `getProfileHash` / `setProfileHash` 实现
- [x] `computeProfileHash` 纯函数：稳定序列化 + SHA-256
- [x] `hasProfileChanged` 正确判断画像是否变动
- [x] `getLatestInsightStatusForCustomer` 返回正确 status
- [x] `addInsight` 成功后更新画像哈希
- [x] `triggerBatchInsight` 支持 `customerIds` 与 `onlyChanged`
- [x] 有 pending 洞察的客户被跳过（不调用 LLM）
- [x] 有 confirmed 且画像未变 → 跳过；画像有变 → 纳入
- [x] 有 rejected → 重新洞察
- [x] `POST /api/batch/insight` 读取并透传 `customerIds` / `onlyChanged`
- [x] 返回结果含 `skipped` 明细

## pi-gateway
- [x] `runBatchInsight` 按传入 `customerIds` 遍历

## 前端
- [x] `triggerBatchInsight` 支持 `customerIds` + `onlyChanged`
- [x] `BatchInsightResult` 类型含 `skipped`
- [x] "批量"与"多选"按钮合并为单个"批量操作"按钮
- [x] 多选栏操作按钮显示"客户洞察"与"方案生成"（无"批量"字样）
- [x] 多选栏"仅分析画像有变动的客户"开关存在且生效
- [x] `doBatchInsight` 使用选中客户 + onlyChanged
- [x] 批量洞察完成后刷新提醒区与客户列表
- [x] 提醒栏"待确认洞察"标签按 pending 洞察筛选（非画像标签）

## 集成验证
- [x] 全栈启动正常
- [x] 多选模式交互正确
- [x] 仅画像变动客户被处理
- [x] pending 客户被跳过
- [x] onlyChanged 开关开/关行为正确
- [x] 提醒栏标签快捷筛选正确
- [x] 方案生成正常