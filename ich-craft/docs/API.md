# API 手册（真实可调用）

所有写操作建议带 `Idempotency-Key`（任意唯一字符串）；重复带同键请求回放首次响应，
并在响应头返回 `Idempotency-Replayed: true`。管理员接口需 `X-Admin-Key`。

## 公共 API

### GET /api/crafts
技艺列表（含封面图——是否返回图受**展示授权**控制）

### GET /api/crafts/:slug
技艺详情：材料、传承人、代表作品（无展示授权时只给元信息）

### GET /api/works/:slug
故事页数据：

```json
{
  "work": { "title": "蓝白方巾", "version_no": 2, "published_at": "..." },
  "inheritor": { "name": "段银海", "title": "...", "bio": "..." },
  "materials": [{ "name": "板蓝根靛泥", "origin": "段家染缸", "usage": "..." }],
  "cover": null,
  "steps": [],
  "grants": {
    "display": { "status": "active|none|revoked|expired", "expires_at": null, "reason": null },
    "teaching": { "status": "active|none|revoked|expired", "expires_at": null, "reason": null }
  },
  "availability_note": "展示授权已到期，作品图片暂不可见。 ..."
}
```

`cover` 为 null = 展示授权问题；`steps` 为空 = 教学授权问题。两者独立。

## 报名 API

### POST /api/bookings/sessions/:id/holds
`{ "name": "李雷", "contact": "li@x.com" }`

- 201 `{ "outcome": "held", "hold": { "id", "expires_at", ... } }` — 短暂保留
- 202 `{ "outcome": "waitlisted", "waitlist": {...} }` — 满员进候补
- 200 `{ "outcome": "already_enrolled", ... }` — 该联系人已确认报名（双浏览器场景）

### POST /api/bookings/holds/:id/confirm
`{ "contact": "li@x.com" }`（可选，用于校验归属）

### POST /api/bookings/holds/:id/release
`{ "contact": "li@x.com" }`（可选，用于校验归属）。
主动放弃尚未确认的保留名额；服务端立即释放并在同一事务内递补候补队首。
候补邀请被本人放弃时，候补记录标记为 `cancelled`；已确认报名不会被删除。

| HTTP | code | 含义（前端解释） |
| --- | --- | --- |
| 200 | confirmed | 报名成功（含重复确认回放、promoted 递补结果） |
| 410 | HOLD_EXPIRED | **席位原因**：保留超时，名额已回收，可重报或候补 |
| 410 | HOLD_GONE | **席位原因**：占位被释放（如减容量） |
| 410 | CAPACITY_REDUCED | **席位原因**：管理员减容量后确认人数已满，转候补 |
| 409 | ALREADY_ENROLLED | **席位原因**：同一联系方式已有确认记录（另一浏览器） |
| 409 | IDEMPOTENCY_KEY_REUSE | 同键不同体 |

### POST /api/bookings/enrollments/:id/cancel
取消确认报名（记录保留为 cancelled），同事务递补队首候补。

### GET /api/bookings/my-enrollments?contact=
返回所有报名（含 cancelled），并对比当前课表：`schedule_changed`、`note`。

### GET /api/bookings/waitlist?contact=&session_id=
候补状态：waiting / invited / converted / expired / cancelled；
`invited` 时带 `hold_id` 与 `invite_expires_at`。

## 管理 API（X-Admin-Key）

### GET /api/admin/overview
课次（confirmed/held/waiting）、授权（含 effective 判定）、作品版本概览。

### POST /api/admin/sessions
`{title,location,start_at,end_at,capacity,craft_id,work_id}`

### PATCH /api/admin/sessions/:id/capacity
`{capacity}` → 200 带 displaced（挤出转候补）/ promoted（扩容量时递补）；
减容量不会把人递补进更少的席位；新容量低于已确认 → 422 CAPACITY_BELOW_ENROLLED。

### PATCH /api/admin/sessions/:id/reschedule
`{start_at,end_at}` → schedule_version+1，报名全部保留。

### POST /api/admin/grants
`{work_id, scope:"display"|"teaching", expires_at:null}`

### POST /api/admin/grants/:id/revoke
`{reason}` — 仅翻转该 scope 的授权状态，写 grant_events，不删任何数据。

### POST /api/admin/assets
`{url,alt,mime}`

### POST /api/admin/works/:id/swap-cover
`{asset_id}` — 改草稿快照中的封面；线上仍展示旧发布版本直至 publish。

### POST /api/admin/works/:id/publish
把草稿固化为**不可变新版本**（version_no+1），works.published_version_id 指向它。

### GET /api/admin/grant-events
授权授予/撤回流水。

## 内容不可用 vs 席位不可用（错误域）

| | 内容域 | 席位域 |
| --- | --- | --- |
| 典型返回 | cover=null / steps=[] / 404 WORK_NOT_FOUND | 410 HOLD_EXPIRED、410 CAPACITY_REDUCED 等 |
| 提示色 | 暗红 notice | 黄色 notice |
| 关联 | 展示与教学独立 | 候补/保留中/已确认 |
| 历史数据 | 旧版本快照仍在 | cancelled 记录仍在 |
