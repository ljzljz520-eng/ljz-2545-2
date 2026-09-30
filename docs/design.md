# 站内设计依据（与 /design 页对应）

## 设计令牌
- 竹青 `#3F6B53`（主色/已确认）、竹黄 `#C4A15F`（保留/候补）、朱砂印 `#8C3A2B`（关键动作/撤回/到期）
- 宣纸 `#F6F0E2`（底）、墨 `#2F2A20`（文字）、金线 `#E9D9B5`
- 字体：标题 Noto Serif SC / 宋体；正文 PingFang / 系统无衬线
- 纹理：CSS 重复渐变模拟宣纸纤维；SVG 六角编 pattern 作分隔带与“锁定/下架”占位纹

## 原创图形（均为手工 SVG，无外部图片）
- `logo.svg` 方印 + 抽象经纬编
- `work-yueyin.svg`（六角编茶篓 + 月夜负形）、`work-yueyin-v2.svg`（换图演示）
- `work-shanlan.svg`（同心圆米筛 + 密编 + 红绳）、`work-tuihe.svg`（撤回占位）
- `portrait-lin.svg` 虚构传承人画像
- `material-{bamboo,oil,strips,thread}.svg` 四种材料图标

## 信息与状态设计
- 两类不可用严格区分视觉语言：席位=黄色提示条 🎟️；内容=朱砂提示条 🚫/⏳
- 徽标：已确认=绿、短暂保留/候补=黄、取消/过期/撤回=红/灰，全站一致
- 倒计时以服务端 `hold_expires_at` 为准，到点重新轮询而非本地判定
- 候补页 4s 轮询；被晋升即切换为倒计时；课次列表 5s 刷新席位
- 改期订单并列展示「报名时快照时间」与「当前排期时间/版本」

## 并发方案设计
预约保留：事务 `SELECT * FROM courses WHERE id=? FOR UPDATE` → 回收本事务内已过期 held →
统计 held/confirmed/waitlisted → 有空位插 held 否则 waitlisted。候补晋升使用
`FOR UPDATE SKIP LOCKED` 按 `waitlist_seq` 顺序取出。唯一索引
`uq_bookings_active(course_id, student_contact) WHERE status IN (held,confirmed,waitlisted)`
保证同一学员跨浏览器只有一笔活跃订单；`idempotency_key UNIQUE` 保证重试不重复。
