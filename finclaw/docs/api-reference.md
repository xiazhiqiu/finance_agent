# API 接口文档

## 概述

- 后端地址：`http://127.0.0.1:3001`
- 内容类型：`application/json; charset=utf-8`
- 认证方式：Session Cookie（`session`）
- 权限模型：RBAC（`admin` / `manager`）

---

## 1. 公开接口（无需登录）

### 1.1 健康检查

```
GET /health
```

**响应**

```json
{ "ok": true, "service": "finance-backend" }
```

---

### 1.2 登录

```
POST /api/auth/login
```

**请求体**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| username | string | 是 | 用户名 |
| password | string | 是 | 密码 |

**响应**

```json
{
  "managerId": "MGR_001",
  "name": "张三",
  "role": "manager",
  "avatar": ""
}
```

| 字段 | 说明 |
|------|------|
| managerId | 用户唯一标识 |
| name | 用户姓名 |
| role | 角色：`admin` 或 `manager` |
| avatar | 头像 URL（当前为空） |

**说明**：登录成功后在响应 `Set-Cookie` 中返回 session token，后续请求自动携带。

---

### 1.3 登出

```
POST /api/auth/logout
```

**响应**

```json
{ "success": true }
```

---

### 1.4 重置密码（无需登录）

```
POST /api/auth/reset-password-public
```

**请求体**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| username | string | 是 | 用户名 |
| oldPassword | string | 是 | 旧密码 |
| newPassword | string | 是 | 新密码 |

**响应**

```json
{ "success": true }
```

---

## 2. 管理员接口（需 admin 角色）

所有管理员接口路径前缀为 `/api/admin/`，需要 `role: "admin"` 的 session。

### 2.1 列出所有客户经理

```
GET /api/admin/managers
```

**响应**

```json
[
  {
    "managerId": "MGR_001",
    "username": "zhangsan",
    "name": "张三",
    "customerCount": 2
  }
]
```

| 字段 | 说明 |
|------|------|
| managerId | 客户经理 ID |
| username | 登录用户名 |
| name | 姓名 |
| customerCount | 名下客户数量 |

---

### 2.2 新增客户经理

```
POST /api/admin/managers
```

**请求体**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| username | string | 是 | 登录用户名（不可重复） |
| name | string | 是 | 姓名 |

**响应** `201`

```json
{
  "managerId": "MGR_003",
  "username": "wangwu",
  "name": "王五"
}
```

**说明**：初始密码统一为 `123456`。

---

### 2.3 编辑客户经理

```
PUT /api/admin/managers/:managerId
```

**请求体**（至少传一个字段）

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| username | string | 否 | 新用户名 |
| name | string | 否 | 新姓名 |

**响应**

```json
{ "success": true }
```

---

### 2.4 删除客户经理

```
DELETE /api/admin/managers/:managerId
```

**约束**
- 超级管理员 `MGR_ADMIN` 不可删除
- 若该客户经理名下还有客户，返回 400 错误，需先转移所有客户

**响应**

```json
{ "success": true }
```

**错误响应** `400`

```json
{ "error": "该客户经理名下还有 2 个客户，请先转移所有客户" }
```

---

### 2.5 列出所有客户

```
GET /api/admin/customers
```

**响应**

```json
[
  {
    "customerId": "CUST_001",
    "name": "张明远",
    "segment": "私行客户",
    "occupation": "制造业企业主",
    "riskTolerance": "C3",
    "aum": 5000000,
    "aumStructure": { "活期": 1000000, "定期存款": 2000000, "理财": 1500000, "基金": 500000 },
    "assignedManagerId": "MGR_001",
    "assignedManagerName": "张三"
  }
]
```

| 字段 | 说明 |
|------|------|
| assignedManagerId | 分配的客户经理 ID，`null` 表示未分配 |
| assignedManagerName | 分配的客户经理姓名，`null` 表示未分配 |

---

### 2.6 新增客户

```
POST /api/admin/customers
```

**请求体**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| name | string | 是 | 客户姓名 |

**响应** `201`

```json
{
  "customerId": "CUST_004",
  "name": "新客户",
  "segment": "",
  "occupation": "",
  "riskTolerance": "",
  "aum": 0,
  "aumStructure": {},
  ...
}
```

**说明**：新客户 aum 为 0，处于"待编辑"状态，客户经理需编辑画像后才能生成方案。

---

### 2.7 编辑客户姓名

```
PUT /api/admin/customers/:customerId
```

**请求体**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| name | string | 否 | 新客户姓名 |

**响应**

```json
{ "success": true }
```

---

### 2.8 删除客户

```
DELETE /api/admin/customers/:customerId
```

**说明**：删除客户时会同时删除：
- 客户数据（从客户列表中移除）
- 客户-经理映射关系
- 该客户的所有方案快照

**响应**

```json
{ "success": true }
```

---

### 2.9 分配客户经理

```
PUT /api/admin/customers/:customerId/assign
```

**请求体**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| managerId | string \| null | 是 | 客户经理 ID，传 `null` 取消分配 |

**说明**
- 如果客户从经理 A 转移给经理 B，会自动删除经理 A 为该客户生成的方案快照
- 分配前弹出确认提示框，提醒管理员快照会丢失

**响应**

```json
{ "success": true }
```

---

## 3. 客户经理接口（需 manager 角色，需登录）

管理员调用这些接口会返回 403。

### 3.1 获取当前用户信息

```
GET /api/auth/me
```

**响应**

```json
{
  "managerId": "MGR_001",
  "username": "zhangsan",
  "name": "张三",
  "role": "manager",
  "avatar": ""
}
```

---

### 3.2 重置密码

```
POST /api/auth/reset-password
```

**请求体**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| oldPassword | string | 是 | 旧密码 |
| newPassword | string | 是 | 新密码 |

**响应**

```json
{ "success": true }
```

---

### 3.3 获取分配客户列表

```
GET /api/customers
```

**说明**：仅返回分配给当前登录客户经理的客户。

**响应**

```json
[
  {
    "customerId": "CUST_001",
    "name": "张明远",
    "segment": "私行客户",
    ...
  }
]
```

---

### 3.4 获取客户详情

```
GET /api/customers/:customerId/profile
```

**权限**：只能访问分配给自己的客户，否则返回 403。

**响应**：返回完整客户对象。

---

### 3.4.1 偏好选项（前端写死）

偏好下拉选项不再通过后端接口获取，已**写死在前端** `main.ts` 的 `FinanceAdvisorApp.PREFERENCE_OPTIONS` 常量中（23 项，取自 seed.json 全部客户偏好去重）。编辑画像时直接使用该常量渲染 multiple select 下拉。

---

### 3.5 获取客户级会话摘要

```
GET /api/customers/:customerId/summary
```

**权限**：只能访问分配给自己的客户，否则返回 403；客户不存在返回 404。

**响应**：返回摘要对象；无摘要时返回 `null`。

```json
{
  "customerId": "CUST_001",
  "preferences": ["稳健收益"],
  "adoptedPlans": ["P001"],
  "concerns": ["担心市场波动"],
  "opportunities": ["到期资金承接"],
  "raw": "客户偏好稳健收益，关注流动性……",
  "updatedAt": "2026-01-01T00:00:00.000Z"
}
```

---

### 3.6 保存客户级会话摘要

```
PUT /api/customers/:customerId/summary
```

**说明**：覆盖式保存，按 customerId 整体覆盖写入并刷新 `updatedAt`。

**请求体**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| raw | string | 是 | 摘要原文（必须为字符串） |
| preferences | string[] | 否 | 偏好标签（数组内非字符串项被过滤） |
| adoptedPlans | string[] | 否 | 已采用方案 |
| concerns | string[] | 否 | 关注点 |
| opportunities | string[] | 否 | 机会点 |

**权限**：只能保存分配给自己的客户，否则返回 403；客户不存在返回 404。

**响应**：返回保存后的摘要对象（含 `updatedAt`）。

**错误响应** `400`

```json
{ "error": "raw 必须为字符串" }
```

---

### 3.7 编辑客户画像

```
PUT /api/customers/:customerId
```

**请求体**（所有字段可选）

| 字段 | 类型 | 说明 |
|------|------|------|
| segment | string | 客户分层 |
| occupation | string | 职业 |
| riskTolerance | string | 风险承受等级（C1-C5） |
| aum | number | 资产管理规模（与 aumStructure 合计值互斥，二选一传） |
| aumStructure | object | 资产结构明细，如 `{"活期": 100000, "定期": 200000}` |
| recentTransactions | string | 近期交易摘要 |
| lastContact | object | 最近联系记录 `{ channel, date, topic }` |
| preferences | string[] | 偏好列表 |
| lifeCycleStage | string | 生命周期阶段 |
| riskAssessmentDate | string | 风险评估日期 |
| latestInsight | string | 最新客户洞察全文；覆盖式更新该客户最新一条 insight 的 content（insightId/时间戳等元信息不变，无洞察时忽略） |

**AUM 校验规则**
- 若传了 `aumStructure`，后端计算 `sum(aumStructure)` 作为 aum
- 若同时传了 `aum`，会校验 `aum === sum(aumStructure)`，不匹配返回 400

**响应**：返回更新后的完整客户对象。

---

### 3.8 获取合格产品

```
GET /api/products/eligible?customerId=CUST_001
```

**说明**：根据客户风险承受等级过滤在售且有配额的产品。

---

### 3.9 获取策略列表

```
GET /api/products/strategies
```

---

### 3.10 获取产品详情

```
GET /api/products/:id
```

**说明**：按 `productId` 返回产品全字段详情（含 `subCategory` / `tenor` / `expectedReturn` / `description` / `benchmark` / `returns` / `marketTags` / `highlights` / `scriptTemplate`），前端产品详情弹窗使用；不校验在售/配额，仅按 ID 取数，产品不存在返回 404。

---

### 3.11 获取知识库

```
GET /api/knowledge
```

**响应**

```json
{
  "talkTemplates": "话术模板内容",
  "productPriority": "产品优先度内容",
  "stylePreference": "风格偏好内容",
  "content": "原始 Markdown"
}
```

---

### 3.12 保存知识库

```
POST /api/knowledge/save
```

**请求体**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| content | string | 否 | 完整 Markdown 内容 |
| talkTemplates | string | 否 | 话术模板 |
| productPriority | string | 否 | 产品优先度 |
| stylePreference | string | 否 | 风格偏好 |

**响应**

```json
{ "success": true, "content": "..." }
```

---

### 3.13 获取市场简报

```
GET /api/market/brief
```

**响应**

```json
{ "content": "市场整体平稳，权益类短期震荡……" }
```

**说明**：无简报时 `content` 为空字符串。

---

### 3.14 保存市场简报

```
PUT /api/market/brief
```

**权限**：manager 角色（客户经理专属）。

**请求体**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| content | string | 是 | 简报内容（必须为字符串） |

**响应**

```json
{ "content": "市场整体平稳，权益类短期震荡……" }
```

**错误响应** `400`

```json
{ "error": "content 必须为字符串" }
```

---

### 3.15 合规审查

```
POST /api/plans/audit
```

**请求体**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| customerId | string | 是 | 客户 ID |
| plans | object[] | 是 | 方案列表 |

---

### 3.16 保存方案快照

```
POST /api/plans/snapshots
```

**请求体**（扁平字段，由前端在方案生成/优化落地时自动调用）

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| planId | string | 是 | 方案唯一标识（幂等键） |
| customerId | string | 是 | 客户 ID |
| managerId | string | 否 | 客户经理 ID |
| title | string | 否 | 方案标题 |
| score | number | 否 | 方案评分 |
| tags | string[] | 否 | 方案标签 |
| diagnosis | string | 否 | 客户诊断 |
| allocation | object | 否 | 资产配置结构 |
| products | object[] | 否 | 产品组合 |
| scripts | object[] | 否 | 营销话术 |
| markdown | string | 否 | 方案 Markdown 内容 |
| generation | string | 否 | `initial` / `optimize` |
| instruction | string \| null | 否 | 优化指令（optimize 时） |
| adopted | boolean | 否 | 是否已成交（默认 false） |

**说明**：按 `planId` 幂等更新——同一 planId 已落盘时覆盖旧快照字段，保留原 `id` / `createdAt` 并刷新 `updatedAt`。

**响应** `201`：返回保存的快照对象。

---

### 3.17 获取方案快照列表

```
GET /api/plans/:planId/snapshots
```

**说明**：按方案 ID 查询其历史快照列表。

---

### 3.18 会话管理 API

方案会话持久化存储，用于历史对话与多会话管理。

#### 3.18.1 获取客户会话列表

```
GET /api/sessions?customerId=:customerId
```

**说明**：列出某客户的所有会话，按 `updatedAt` 降序排序。

**权限**：只能查询分配给当前登录客户经理的客户；内部调用可通过 `X-Internal-Token` 跳过权限检查。

**响应**：返回 `PlanSession[]` 数组。

---

#### 3.18.2 获取单个会话详情

```
GET /api/sessions/:sessionId
```

**权限**：只能访问当前登录客户经理名下客户的会话。

**响应**：返回完整会话对象（含 `plans`、`selectedPlanId`、`adoptedPlanId` 等）。

---

#### 3.18.3 新建会话

```
POST /api/sessions
```

**请求体**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| customerId | string | 是 | 客户 ID |
| title | string | 否 | 自定义会话标题（不传使用默认生成） |

**权限**：只能为分配给当前登录客户经理的客户创建会话。

**响应** `201`：返回新建会话对象。

---

#### 3.18.4 更新会话

```
PUT /api/sessions/:sessionId
```

**请求体**（仅更新允许修改的字段）

| 字段 | 类型 | 说明 |
|------|------|------|
| plans | object[] | 方案列表 |
| selectedPlanId | string | 当前选中方案 ID |
| adoptedPlanId | string | 已成交方案 ID |
| lastInstruction | string | 最后一条优化指令 |
| complianceReport | object | 合规审查报告 |
| title | string | 会话标题 |
| sessionKey | string | Pi SDK Agent 会话 Key |

**权限**：只能修改当前登录客户经理名下客户的会话。

**响应**：返回更新后的会话对象。

---

#### 3.18.5 删除会话

```
DELETE /api/sessions/:sessionId
```

**权限**：只能删除当前登录客户经理名下客户的会话。

**响应**：`{ "success": true }`。

---

## 4. 权限矩阵

| 接口路径 | 未登录 | admin | manager |
|----------|--------|-------|---------|
| `/api/auth/login` | 可用 | 可用 | 可用 |
| `/api/auth/logout` | 可用 | 可用 | 可用 |
| `/api/auth/reset-password-public` | 可用 | 可用 | 可用 |
| `/api/admin/*` | 401 | 可用 | 403 |
| `/api/auth/me` | 401 | 403 | 可用 |
| `/api/customers` | 401 | 403 | 可用 |
| `/api/customers/:id` | 401 | 403 | 可用 |
| `/api/customers/:id/profile` | 401 | 403 | 可用 |
| `/api/products/*` | 401 | 403 | 可用 |
| `/api/knowledge/*` | 401 | 403 | 可用 |
| `/api/plans/*` | 401 | 403 | 可用 |
| `/api/sessions` | 401 | 403 | 可用 |
| `/api/sessions/:id` | 401 | 403 | 可用 |

---

## 5. 错误码

| HTTP 状态码 | 含义 |
|-------------|------|
| 200 | 成功 |
| 201 | 创建成功 |
| 400 | 请求参数错误 |
| 401 | 未登录 |
| 403 | 无权限（角色不匹配） |
| 404 | 资源不存在 |
| 409 | 冲突（如用户名重复） |
| 500 | 服务器内部错误 |

---

## 6. pi-gateway 接口（端口 18789）

> 以下接口由 pi-gateway 提供（`http://127.0.0.1:18789`），与上文 backend（3001）接口分属不同服务，不走 Session Cookie 鉴权。

### 6.1 手动压缩会话上下文

```
POST /api/sessions/:sessionKey/compact
```

**说明**：对指定会话手动触发 SDK compaction，将旧对话历史压缩为结构化摘要。body 可选（空 body 或解析失败均视为 `{}`）。

**请求体**（可选）

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| customInstructions | string | 否 | 压缩指令，引导摘要聚焦业务关键信息（如「保留客户风险偏好、已采用方案 planId 与待办事项」） |

**响应**

```json
{ "data": { "CompactionResult": "..." } }
```

**错误响应** `400`：会话已压缩过或内容过小无需压缩。