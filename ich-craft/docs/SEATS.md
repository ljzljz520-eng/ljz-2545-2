# 席位方案比较：实时扣减 vs 预约保留

## 方案一：实时扣减（提交即扣，不保留）

| 维度 | 题目要求 | 短暂保留 |
| --- | --- | --- |
| 用户填表时间 | 信息校验通过后立即占座，没填完也扣 | **不占**，只有「点击报名」后才占 |
| 高并发下 | 唯一约束兜底，最后一个拿到行锁的成功；输家得到 409 | 输家自动进候补，而非简单报错 |
| 「两个浏览器各显成功」 | 部分实现：第二浏览器若在第一确认前进入，会看到「已满」但可以继续点 | 完全实现：确认阶段二次校验容量与重复联系人，第二浏览器至多显示保留中或候补 |
| 用户感知 | 失败即终态，易反复刷新、重复提交 | 有明确「保留倒计时」，知道何时必须行动 |
| 实现复杂度 | 0 保留期，无超时回收 | 需要 `holds` 后台 sweep、invite TTL |

## 选择：预约保留（本项目实现）

题目明确要求「课程名额先短暂保留再确认」，且要求「两个浏览器各自显示最后一个名额成功」不发生。
两种方案都依赖同一套并发控制底座，不同点仅在于扣减发生的时点与失败后的去向：

```
POST /holds → 行锁串行判定 → 有空位？(可报可确认) : (排队候补)
                       ↓
        active holds 倒计时（默认 90 秒）
                       ↓
POST /holds/:id/confirm → 再次行锁判定 → INSERT enrollments
                       ↓                    ↑ 唯一索引兜底
                  放弃（立即）/超时（sweep） → 释放 → promoteWaitlist()
```

### 并发正确性的三道防线

1. **`SELECT … FOR UPDATE` 锁 sessions 行**：同一课次所有占位/确认/取消/改容量互斥，
   计数与决策在同一事务内完成，消除「读后写」竞态。
2. **部分唯一索引** `uq_enrollment_active_contact`：
   `CREATE UNIQUE INDEX … ON enrollments(session_id, contact) WHERE status='confirmed'`
   即使应用层漏判，数据库也拒绝同一人两条有效报名；取消行不占唯一约束（历史保留）。
3. **幂等中间件**：`Idempotency-Key` + 请求体哈希，重复提交（含断网重试）回放首次结果，
   同键不同体 409；同键并发通过 `pg_advisory_xact_lock` 串行化，只有首个请求执行业务动作。

### 超时回收与取消后的候补顺序

- **后台 sweep**（默认 15s）：`holds.status='active' AND expires_at<=now()` → expired；
  对应候补邀请一并失效；随后对每个释放课次执行 `promoteWaitlist`。
- **promoteWaitlist**：`ORDER BY priority DESC, created_at ASC` ——
  被管理员减容量挤出的人 priority=1，排在普通候补(priority=0)前面；同优先级先到先得。
- **取消确认 / 主动放弃**：同事务翻转 enrollment 为 cancelled（记录保留）或把 hold 标记 released，
  立刻 promoteWaitlist；主动放弃无需等待 TTL。
- **递补确认窗**：候补者得到一个新 hold（`source='waitlist'`），默认 10 分钟确认；
  未确认则 invite 过期、名额继续给下一位。

### 管理员减容量的处理

- 新容量 < 已确认人数 → 422 拒绝（不能把已报名者挤走，课程记录不可删）。
- 否则释放「最新创建的 N 个未确认占位」（`ORDER BY created_at DESC`），
  被挤者自动进入候补队首（priority=1），再尝试把空缺席位递补给其他候补者。
- 已在确认页等待的人若此时点确认，得到 `CAPACITY_REDUCED`（410），前端提供「转候补」。

## 为什么两个浏览器不可能都显示成功

设容量 N，已有 N-1 确认。两个浏览器同时 POST /holds：

1. 两个事务都要 `SELECT … FOR UPDATE` 同一行，PG 只放行一个；
   第一个看到 occupied=N-1 < N → 插入 hold 提交。
2. 第二个拿到锁后看到 confirmed+held=N → 进入 waitlist（202），不产生 hold。
3. 第一个 confirm 时二次检查 `confirmed_count >= capacity` 与同联系人唯一约束；
   若期间管理员把容量降到 N-1，确认失败并提示转候补。
4. 即使两个浏览器用**同一联系方式**（同一人两台设备），唯一索引保证最多一条 confirmed；
   hold 阶段也会复用已有 hold 或返回 already_enrolled。
