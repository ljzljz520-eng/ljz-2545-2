# 守艺 · 非遗手作主题网站

围绕「材料 — 作品 — 传承人」的技艺故事站，附带完整的**内容授权**与**课程席位**后端。
技术栈：Node.js + Express + PostgreSQL（`pg` 驱动）+ 原生前端（无框架）。

## 它解决什么问题

| 领域 | 规则 |
| --- | --- |
| 技艺故事 | 作品故事页串联材料、作品步骤（教学版本）与传承人 |
| 授权分离 | **展示（display）**与**教学（teaching）**两种用途独立授权；撤回展示只让素材下线，不碰教学内容 |
| 撤回不删史 | 授权撤回 / 素材换图，只影响线上版本；已发布版本快照与已发生的课程记录永不删除 |
| 报名席位 | 「预约保留」：提交→服务端短暂保留（默认 90s）→确认；超时服务端回收 |
| 并发安全 | `sessions` 行级锁串行化 + 有效报名唯一索引，两个浏览器不可能同时报上最后一个名额 |
| 候补递补 | 取消、主动放弃、超时、管理员减容量都会按「先后顺序 + 被挤优先级」递补，递补名额限时确认 |
| 重复提交 | `Idempotency-Key` 请求落库回放；断网时前端发件箱暂存，恢复后自动重放不重复 |

## 快速开始

### 方式 A：Docker（生产形态，真实 PostgreSQL）

```bash
docker compose up --build
# 打开 http://localhost:4000 ，管理后台口令默认 change-me-in-production
```

### 方式 B：本机零依赖（嵌入式真实 PostgreSQL，无需 root / Docker）

```bash
npm install
npm run dev        # 自动下载并启动真实 PG 二进制 → 建库 → 播种 → 起服务
# http://localhost:4000 ，管理后台口令 dev-admin-key
```

> `embedded-postgres` 会在 `.pgdata/` 运行一个真实的 PostgreSQL 18 实例，
> 与生产仅差部署形态，SQL/事务/锁行为完全一致。

### 方式 C：自备 PostgreSQL

```bash
createdb ichcraft
PGHOST=... PGUSER=... PGPASSWORD=... npm run seed
PGHOST=... npm start
```

环境变量：`PORT`、`HOLD_TTL_MS`（占位保留时长）、`INVITE_TTL_MS`（候补确认窗）、
`SWEEP_INTERVAL_MS`（回收扫描间隔）、`ADMIN_KEY`、`PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE`。

## 页面

- `#/` 首页：技艺卡片、席位规则说明
- `#/story/:slug` 技艺故事：传承人、材料、作品封面（展示授权）、制作步骤（教学授权）、可参加课次
- `#/sessions` 报名：剩余名额、短暂保留倒计时、确认、候补状态
- `#/my` 我的报名：确认/取消、活动改期提示、历史记录（取消记录保留）
- `#/admin` 管理后台：改容量、改期、授权授予/撤回、换图与发布版本

## 验收

```bash
npm test
```

覆盖：幂等重复提交与同键并发、断网重试发件箱（前端逻辑）、并发抢最后一个名额、
占位超时回收、主动放弃保留、取消后候补顺序、管理员减容量挤出占位、活动改期、
作品换图与发布版本、展示/教学授权撤回与到期、席位原因与内容原因的区分。

## 目录

```
db/schema.sql            PG 表结构（锁/唯一索引/版本快照）
src/services/seats.js    席位：占位、确认、取消、回收、减容量、改期
src/services/content.js  内容：授权判定、故事组装、版本发布、换图
src/middleware/          幂等中间件
src/routes/              public / bookings / admin API
public/                  原创 SVG 视觉 + SPA（js/api.js 含离线发件箱）
tests/acceptance.test.mjs 端到端验收（真实 PG + 真实 HTTP）
docs/                    设计依据、席位方案比较、API 手册、验收手册
```
