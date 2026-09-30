# 百工拾遗 · 非遗手作主题网站

以「闽北竹编」为主题的全栈演示站：技艺故事页把**传承人 — 作品 — 材料 — 展示/教学两版步骤 — 课次**串联；
报名采用**预约保留（hold-then-confirm）**席位方案；后端集中处理**内容授权**与**课程席位**；
PostgreSQL 持久化**订单状态**与**发布版本**。所有人物/作品均为虚构，全部图形为原创 SVG/CSS。

## 一、它解决了什么

| 需求 | 实现 |
| --- | --- |
| 技艺故事串联材料、作品、传承人 | `/story` 一屏聚合：传承人卡、作品故事、材料、两版步骤、相关课次、发布历史 |
| 报名界面突出可参加课次 | `/courses` 实时席位条（确认/保留/候补）、`/booking` 倒计时确认与候补轮询 |
| 后端内容授权 + 课程席位 | `licenses` 授权表（display/teaching 用途分离）+ 席位状态机服务 |
| PG 留存订单状态与发布版本 | `bookings/booking_events` 状态机 + `published_versions` 不可变版本 |
| 教学版与展示授权分离 | `work_steps.display_text` 与 `teaching_text` 分列；授权按 `work+purpose` 独立判定 |
| 撤回展示许可不删课程记录 | 撤回只把许可置 `withdrawn`；`bookings` 与作品名称、课次记录始终保留 |
| 名额短暂保留再确认 | 报名得 `held`（默认 60s），确认转 `confirmed`；超时 sweeper + 事务内双重回收 |
| 重复提交 / 占位过期 / 管理员减容量 | 幂等键唯一约束；超时回收并递补；减容量下限 = 已确认 + 有效保留 |
| 不能两个浏览器各抢最后名额 | 事务内 `SELECT … FOR UPDATE` 锁课次行后统计，再决定 held/waitlisted，零超卖 |
| 超时回收 + 取消后候补顺序 | 回收/取消后按 `waitlist_seq` 用 `FOR UPDATE SKIP LOCKED` 顺序晋升为 held |
| 解释席位/内容不可用差异 | 两类独立的提示条（🎟️席位=黄色；🚫内容=朱砂），文案说明原因 |
| 真实 API + 持久状态 + 可部署 | Express + `pg`，Dockerfile / docker-compose 一键起 |

## 二、席位方案：实时扣减 vs 预约保留

- **实时扣减**：提交即扣库存，失败再回补。简单但网络抖动/用户犹豫会假性占满，回补有窗口。
- **预约保留（本站采用）**：报名成功先持有 60 秒，用户确认才锁定；未确认超时自动释放。
  - 并发安全：单事务锁行 + 计数，`held+confirmed` 不得超过 `capacity`；
  - 公平：释放名额时候补队列按排队号顺序获得**同样时长的短暂保留**；
  - 可靠：断网重试使用稳定幂等键，服务端同键返回原单（`retried=true`），不会重复报名。

订单状态机：

```
报名 ──有空闲席位──▶ held ──确认──▶ confirmed ──取消──▶ cancelled ──▶ 触发候补晋升
  │                   └──超时──▶ expired ───────────────▶ 触发候补晋升
  └──无空闲席位──▶ waitlisted ──被晋升──▶ held（重新计时）
held/confirmed/waitlisted ──取消──▶ cancelled（记录保留）
```

## 三、本地运行

需要 Node 20+ 与 PostgreSQL 13+。

```bash
cp .env.example .env          # 按需修改 DATABASE_URL / HOLD_SECONDS / ADMIN_TOKEN
npm install
npm run migrate               # 建表（幂等）
npm run seed                  # 写入演示数据
npm start                     # http://localhost:3000
npm test                      # 13 项验收测试（需先启动服务并 seed）
```

`DATABASE_URL` 支持 tcp 与 unix socket，例如：

- tcp：`postgres://user:pass@localhost:5432/heritage`
- socket：`postgres://postgres@/heritage?host=/tmp&port=5544`

### Docker 一键部署

```bash
docker compose up --build
# app: http://localhost:3000 ；管理令牌见 compose 中 ADMIN_TOKEN
```

## 四、页面与 API 一览

页面：`/`（首页与方案对比）、`/story?slug=`（技艺故事）、`/courses`（课次）、
`/booking?slug=`（报名/倒计时/候补）、`/me`（跨浏览器查我的报名）、
`/admin`（管理台）、`/design`（站内设计依据）。

公开 API：

- `GET /api/works`、`GET /api/works/:slug?contact=`（带授权状态；contact 可解锁教学版）
- `GET /api/materials/:slug`、`GET /api/inheritors`
- `GET /api/courses`、`GET /api/courses/:slug`
- `POST /api/bookings`（body: `course_id,student_name,student_contact,idempotency_key`）
- `POST /api/bookings/:id/confirm`、`POST /api/bookings/:id/cancel`
- `GET /api/bookings/:id`、`GET /api/bookings/:id/poll`、`GET /api/bookings/by-contact/:contact`

管理 API（请求头 `X-Admin-Token`）：

- `POST /api/admin/courses/:id/capacity` `{capacity}`
- `POST /api/admin/courses/:id/reschedule` `{starts_at,ends_at}`
- `POST /api/admin/works/:id/swap-image` `{asset_url,note}`
- `POST /api/admin/licenses` `{licensor_id,subject_type,subject_id,purpose,status,expires_at,scope_note}`
- `POST /api/admin/steps/:id/teaching`、`GET /api/admin/courses/:id/bookings`、`GET /api/admin/audit`
- `POST /api/admin/maintenance/sweep`（手工触发回收）

## 五、验收场景对照

1. **断网重试**：固定幂等键，前端自动重放，服务端返回原单；
2. **同时报名**：容量 1 的课次 12 并发 / 容量 5 的 50 并发，均恰好不超卖；
3. **活动改期**：`schedule_version+1`，订单写 `reschedule_notice`，订单保留旧时间快照，前端显示“已改期”；
4. **作品换图**：新素材生效、旧素材标记 `replaced_by` 留存，作品发布版本 +1；
5. **授权到期/撤回**：内容 API 返回 `expired/withdrawn` 与解释文案；素材隐藏，课程记录不动。

## 六、目录

```
db/schema.sql            表结构（状态机/授权/版本/幂等唯一索引）
server/                  Express + 业务库（lib/seats.js, lib/license.js, lib/admin.js）
public/                  原生 HTML/CSS/JS + 原创 SVG
scripts/                 migrate / seed
tests/acceptance.test.js 13 项验收
```
