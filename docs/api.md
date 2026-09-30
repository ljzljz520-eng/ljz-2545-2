# API 约定与席位/授权规则

## 错误格式
`{ "error": "code", "message": "人类可读说明", ... }`，HTTP 状态语义化（400/401/404/409）。

## 关键错误码
- `already_enrolled`（409）：该手机号/邮箱在此课次已有活跃订单（跨浏览器重复报名）
- `hold_expired`（409）：确认时占位已超时，已释放并递补
- `not_held`（409）：当前状态不允许确认
- `capacity_below_occupied`（409）：减容量低于 已确认+有效保留
- `course_canceled` / `course_not_found`
- `withdrawn` / `expired` / `missing`：内容授权不可用的三种原因（非错误抛出，随 `availability` 返回）

## 授权状态机（只读判定，不删除数据）
active（未撤回且未到期） / withdrawn（撤回） / expired（到期） / missing（从未授权）。
- 作品：display（公开故事/封面/展示步骤）与 teaching（教学步骤，需有效授权+确认报名）分离
- 材料：仅 display
- 撤回/到期均不修改 bookings；历史订单与课次记录持续可查

## 席位计数
- 容量 `capacity`；占用 = held（未过期） + confirmed；`free = capacity - occupied`
- 无空位报名 → waitlisted（`waitlist_seq` 排队）
- 释放路径：confirm 失败/超时（sweeper 每 5s，及每次报名/确认事务内回收）、cancel
- 释放后：在同事务锁课次行并按排队号晋升候补为 held（重新给完整保留时长）
- 管理员减容量下限 = confirmed + 仍在保留窗口的 held，绝不挤出已确认记录

## 发布版本
- 作品：换图、教学步骤修订 → `published_versions(entity_type='work')` +1，更新 `works.published_version`
- 课次：改期、容量变更 → `entity_type='course'` +1；改期同时 `schedule_version+1`、写订单事件
- 订单保存 `course_snapshot`（报名时标题/时间/排期版本），改期后仍可对比
