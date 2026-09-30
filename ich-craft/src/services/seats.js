'use strict';
// ============================================================
// 席位领域服务：预约保留方案（hold → confirm）
// 正确性依靠：SELECT ... FOR UPDATE 锁定 sessions 行，
// 使同一课次的占位/确认/取消全部串行，配合唯一索引杜绝超卖与重复占座。
// ============================================================
const db = require('../db');
const config = require('../config');
const { ApiError } = require('../util');

async function counts(client, sessionId, excludeHoldId = null) {
  const r = await client.query(
    `SELECT
        (SELECT count(*)::int FROM enrollments
           WHERE session_id=$1 AND status='confirmed') AS confirmed_count,
        (SELECT count(*)::int FROM holds
           WHERE session_id=$1 AND status='active' AND expires_at > now()
             AND ($2::uuid IS NULL OR id <> $2)) AS held_count,
        (SELECT count(*)::int FROM waitlist_entries
           WHERE session_id=$1 AND status='waiting') AS waiting_count,
        (SELECT count(*)::int FROM waitlist_entries
           WHERE session_id=$1 AND status='invited'
             AND invite_expires_at > now()) AS invited_count`,
    [sessionId, excludeHoldId]
  );
  return r.rows[0];
}

async function getSessionLocked(client, sessionId) {
  const r = await client.query(
    'SELECT * FROM sessions WHERE id=$1 FOR UPDATE', [sessionId]
  );
  if (!r.rows[0]) throw new ApiError(404, 'SESSION_NOT_FOUND', '课次不存在或已下架。');
  return r.rows[0];
}

// 候补晋升：在持锁事务内，把等待中的候补依次邀请，直到没有空位
async function promoteWaitlist(client, sessionId, capacity) {
  const promoted = [];
  for (;;) {
    const c = await counts(client, sessionId);
    const occupied = c.confirmed_count + c.held_count;
    if (occupied >= capacity) break;

    const next = await client.query(
      `SELECT * FROM waitlist_entries
        WHERE session_id=$1 AND status='waiting'
        ORDER BY priority DESC, created_at ASC
        LIMIT 1 FOR UPDATE SKIP LOCKED`,
      [sessionId]
    );
    if (!next.rows[0]) break;
    const w = next.rows[0];

    // 候补递补得到的保留时长 = 邀请确认窗（比普通占位更长）
    const hr = await client.query(
      `INSERT INTO holds (session_id, name, contact, status, source, waitlist_entry_id, expires_at)
       VALUES ($1,$2,$3,'active','waitlist',$4, now() + ($5 || ' milliseconds')::interval)
       RETURNING *`,
      [sessionId, w.name, w.contact, w.id, config.inviteTtlMs]
    );
    const hold = hr.rows[0];
    await client.query(
      `UPDATE waitlist_entries
         SET status='invited', hold_id=$2, invited_at=now(),
             invite_expires_at=now() + ($3 || ' milliseconds')::interval
       WHERE id=$1`,
      [w.id, hold.id, config.inviteTtlMs]
    );
    promoted.push({ waitlist_entry_id: w.id, hold_id: hold.id,
      expires_at: hold.expires_at, name: w.name });
  }
  return promoted;
}

// ---------- 1. 创建占位 ----------
async function createHold({ session_id, name, contact }) {
  return db.withTx(async (client) => {
    const session = await getSessionLocked(client, session_id);

    const existing = await client.query(
      `SELECT * FROM enrollments
        WHERE session_id=$1 AND contact=$2 AND status='confirmed'`,
      [session_id, contact]
    );
    if (existing.rows[0]) {
      return { outcome: 'already_enrolled', enrollment: existing.rows[0] };
    }

    const oldHold = await client.query(
      `SELECT * FROM holds
        WHERE session_id=$1 AND contact=$2 AND status='active' AND expires_at > now()`,
      [session_id, contact]
    );
    if (oldHold.rows[0]) {
      return { outcome: 'held', hold: oldHold.rows[0], reused: true };
    }

    const c = await counts(client, session_id);
    const occupied = c.confirmed_count + c.held_count;

    if (occupied < session.capacity) {
      const hr = await client.query(
        `INSERT INTO holds (session_id, name, contact, expires_at)
         VALUES ($1,$2,$3, now() + ($4 || ' milliseconds')::interval)
         RETURNING *`,
        [session_id, name, contact, config.holdTtlMs]
      );
      return { outcome: 'held', hold: hr.rows[0] };
    }

    // 满员 → 进候补；同一联系人已有“仍有效”的候补位则复用。
    // 已错过递补确认窗但 sweep 尚未扫到的邀请，先终结再重新排队。
    const validWait = await client.query(
      `SELECT w.* FROM waitlist_entries w
        WHERE w.session_id=$1 AND w.contact=$2 AND w.status='waiting'
       UNION
       SELECT w.* FROM waitlist_entries w
         JOIN holds h ON h.id=w.hold_id
        WHERE w.session_id=$1 AND w.contact=$2
          AND w.status='invited' AND h.status='active' AND h.expires_at > now()
       ORDER BY created_at DESC`,
      [session_id, contact]
    );
    if (validWait.rows[0]) {
      return { outcome: 'waitlisted', waitlist: validWait.rows[0], reused: true };
    }
    await client.query(
      `UPDATE waitlist_entries
         SET status='expired'
       WHERE session_id=$1 AND contact=$2 AND status='invited'`,
      [session_id, contact]
    );

    const wr = await client.query(
      `INSERT INTO waitlist_entries (session_id, name, contact, priority)
       VALUES ($1,$2,$3, 0) RETURNING *`,
      [session_id, name, contact]
    );
    return { outcome: 'waitlisted', waitlist: wr.rows[0] };
  });
}

// ---------- 2. 确认占位（扣减落库） ----------
async function confirmHold(holdId, contact) {
  return db.withTx(async (client) => {
    const hr = await client.query('SELECT * FROM holds WHERE id=$1 FOR UPDATE', [holdId]);
    const hold = hr.rows[0];
    if (!hold) throw new ApiError(404, 'HOLD_NOT_FOUND', '占位不存在。');
    if (contact && hold.contact !== contact) {
      throw new ApiError(403, 'HOLD_NOT_YOURS', '该占位不属于当前报名人。');
    }

    const session = await getSessionLocked(client, hold.session_id);

    if (hold.status === 'converted') {
      const e = await client.query(
        "SELECT * FROM enrollments WHERE hold_id=$1 AND status='confirmed'", [holdId]
      );
      return { outcome: 'confirmed', enrollment: e.rows[0], reused: true };
    }
    if (hold.status !== 'active') {
      if (hold.status === 'expired') {
        throw new ApiError(410, 'HOLD_EXPIRED', '占位已超时，名额已回收。', { reason: 'expired' });
      }
      if (hold.status === 'released') {
        throw new ApiError(410, 'CAPACITY_REDUCED',
          '管理员已下调本课名额，该保留名额被释放，请转候补。', { reason: 'capacity_reduced' });
      }
      throw new ApiError(410, 'HOLD_GONE', '占位已失效。', { reason: hold.status });
    }
    if (new Date(hold.expires_at).getTime() <= Date.now()) {
      // 当前事务将随 ApiError 回滚；后台 sweep 负责把占位标为过期并递补候补。
      throw new ApiError(410, 'HOLD_EXPIRED', '占位已超时，名额已回收。', { reason: 'expired' });
    }

    // 管理员减容量后：若确认人数已达新容量，则该占位无法确认
    const c = await counts(client, hold.session_id, holdId);
    if (c.confirmed_count >= session.capacity) {
      await client.query("UPDATE holds SET status='released' WHERE id=$1", [holdId]);
      throw new ApiError(410, 'CAPACITY_REDUCED',
        '管理员已下调本课名额，当前席位不足，请转候补。', { reason: 'capacity_reduced' });
    }

    // 同联系人已有确认记录（例如另一浏览器已成功）
    const dup = await client.query(
      `SELECT * FROM enrollments WHERE session_id=$1 AND contact=$2 AND status='confirmed'`,
      [hold.session_id, hold.contact]
    );
    if (dup.rows[0]) {
      await client.query("UPDATE holds SET status='converted', converted_at=now() WHERE id=$1", [holdId]);
      return { outcome: 'confirmed', enrollment: dup.rows[0], reused: true };
    }

    const er = await client.query(
      `INSERT INTO enrollments
         (hold_id, session_id, work_id, name, contact, booked_start_at, booked_end_at, schedule_version_at_booking)
       SELECT $1, s.id, s.work_id, $2, $3, s.start_at, s.end_at, s.schedule_version
         FROM sessions s WHERE s.id=$4
       RETURNING *`,
      [holdId, hold.name, hold.contact, hold.session_id]
    );
    await client.query(
      "UPDATE holds SET status='converted', converted_at=now() WHERE id=$1", [holdId]
    );
    if (hold.source === 'waitlist') {
      await client.query(
        `UPDATE waitlist_entries SET status='converted' WHERE hold_id=$1`, [holdId]
      );
    }
    // 空出的“被占位但未确认”名额继续给候补
    const promoted = await promoteWaitlist(client, hold.session_id, session.capacity);
    return { outcome: 'confirmed', enrollment: er.rows[0], promoted };
  });
}

// 用户主动放弃尚未确认的占位：立即释放，不等 TTL，并按顺序递补候补。
async function releaseHold(holdId, contact) {
  return db.withTx(async (client) => {
    const hr = await client.query('SELECT * FROM holds WHERE id=$1 FOR UPDATE', [holdId]);
    const hold = hr.rows[0];
    if (!hold) throw new ApiError(404, 'HOLD_NOT_FOUND', '占位不存在。');
    if (contact && hold.contact !== contact) {
      throw new ApiError(403, 'HOLD_NOT_YOURS', '该占位不属于当前报名人。');
    }
    const session = await getSessionLocked(client, hold.session_id);

    if (hold.status === 'converted') {
      const e = await client.query(
        "SELECT * FROM enrollments WHERE hold_id=$1 AND status='confirmed'", [holdId]
      );
      return { outcome: 'confirmed', enrollment: e.rows[0], reused: true };
    }
    if (hold.status !== 'active') {
      const code = hold.status === 'expired'
        ? ['HOLD_EXPIRED', '占位已超时，名额已回收。']
        : hold.status === 'released'
          ? ['CAPACITY_REDUCED', '管理员已下调容量，该占位此前已释放。']
          : ['HOLD_GONE', '占位已失效。'];
      throw new ApiError(410, code[0], code[1], { reason: hold.status });
    }
    if (new Date(hold.expires_at).getTime() <= Date.now()) {
      await client.query("UPDATE holds SET status='expired' WHERE id=$1", [holdId]);
      if (hold.waitlist_entry_id) {
        await client.query(
          `UPDATE waitlist_entries SET status='expired'
            WHERE id=$1 AND status='invited'`, [hold.waitlist_entry_id]
        );
      }
      const expiredPromoted = await promoteWaitlist(client, session.id, session.capacity);
      return { outcome: 'expired', promoted: expiredPromoted };
    }

    await client.query("UPDATE holds SET status='released' WHERE id=$1", [holdId]);
    if (hold.waitlist_entry_id) {
      // 候补邀请被本人主动放弃：该候补位终结，名额继续给下一位。
      await client.query(
        `UPDATE waitlist_entries SET status='cancelled'
          WHERE id=$1 AND status='invited'`, [hold.waitlist_entry_id]
      );
    }
    const promoted = await promoteWaitlist(client, session.id, session.capacity);
    return { outcome: 'released', promoted };
  });
}

// ---------- 取消报名 → 名额释放 → 候补递补 ----------
async function cancelEnrollment(enrollmentId, reason) {
  return db.withTx(async (client) => {
    const er = await client.query(
      'SELECT * FROM enrollments WHERE id=$1 FOR UPDATE', [enrollmentId]
    );
    const en = er.rows[0];
    if (!en) throw new ApiError(404, 'ENROLLMENT_NOT_FOUND', '报名记录不存在。');
    if (en.status !== 'confirmed') {
      throw new ApiError(409, 'ENROLLMENT_NOT_ACTIVE', '该报名已取消。');
    }
    const session = await getSessionLocked(client, en.session_id);
    await client.query(
      `UPDATE enrollments SET status='cancelled', cancelled_at=now(), cancel_reason=$2
        WHERE id=$1`,
      [enrollmentId, reason || '用户取消']
    );
    const promoted = await promoteWaitlist(client, session.id, session.capacity);
    return { outcome: 'cancelled', promoted };
  });
}

// ---------- 定时回收：过期占位 / 过期邀请，然后递补 ----------
async function sweep() {
  return db.withTx(async (client) => {
    const expired = await client.query(
      `UPDATE holds SET status='expired'
        WHERE status='active' AND expires_at <= now()
        RETURNING id, session_id, source, waitlist_entry_id`
    );
    for (const h of expired.rows) {
      if (h.waitlist_entry_id) {
        await client.query(
          `UPDATE waitlist_entries SET status='expired' WHERE id=$1 AND status='invited'`,
          [h.waitlist_entry_id]
        );
      }
    }
    await client.query(
      `UPDATE waitlist_entries SET status='expired'
        WHERE status='invited' AND invite_expires_at <= now()`
    );

    const sessionIds = [...new Set(
      expired.rows.map((r) => r.session_id)
    )];
    const allPromoted = [];
    for (const sid of sessionIds) {
      const s = await getSessionLocked(client, sid);
      allPromoted.push(...await promoteWaitlist(client, sid, s.capacity));
    }
    return { expired_holds: expired.rowCount, promoted: allPromoted };
  });
}

// ---------- 管理员调整容量 ----------
async function setCapacity(sessionId, newCapacity) {
  return db.withTx(async (client) => {
    const session = await getSessionLocked(client, sessionId);
    if (!Number.isInteger(newCapacity) || newCapacity < 0) {
      throw new ApiError(400, 'BAD_CAPACITY', '名额必须是非负整数。');
    }
    const c = await counts(client, sessionId);
    if (newCapacity < c.confirmed_count) {
      throw new ApiError(422, 'CAPACITY_BELOW_ENROLLED',
        `已有 ${c.confirmed_count} 位确认报名，容量不能低于该人数。`,
        { confirmed: c.confirmed_count }
      );
    }
    await client.query('UPDATE sessions SET capacity=$2 WHERE id=$1', [sessionId, newCapacity]);

    // 容量减小挤出的最新占位：释放并以高优先级转入候补队首。
    // 已确认报名永不会被挤出；重复联系人合并到同一条开放候补记录。
    let displaced = [];
    if (newCapacity < c.confirmed_count + c.held_count) {
      const overflow = c.confirmed_count + c.held_count - newCapacity;
      const victims = await client.query(
        `SELECT * FROM holds WHERE session_id=$1 AND status='active' AND expires_at > now()
          ORDER BY created_at DESC LIMIT $2 FOR UPDATE SKIP LOCKED`,
        [sessionId, overflow]
      );
      for (const h of victims.rows) {
        await client.query("UPDATE holds SET status='released' WHERE id=$1", [h.id]);
        if (h.waitlist_entry_id) {
          // 邀请在减容量前已因 TTL 终结，则不需要再改这条历史。
          await client.query(
            `UPDATE waitlist_entries
               SET status='waiting', hold_id=NULL, invited_at=NULL,
                   invite_expires_at=NULL, priority=GREATEST(priority,1)
             WHERE id=$1 AND status='invited'`,
            [h.waitlist_entry_id]
          );
          displaced.push({ hold_id: h.id, waitlist_entry_id: h.waitlist_entry_id });
        } else {
          const wr = await client.query(
            `INSERT INTO waitlist_entries (session_id, name, contact, priority)
             VALUES ($1,$2,$3,1)
             ON CONFLICT (session_id, contact) WHERE status IN ('waiting','invited')
             DO UPDATE SET priority=GREATEST(waitlist_entries.priority, EXCLUDED.priority),
                           status='waiting', hold_id=NULL,
                           invited_at=NULL, invite_expires_at=NULL
             RETURNING *`,
            [sessionId, h.name, h.contact]
          );
          displaced.push({ hold_id: h.id, waitlist_entry_id: wr.rows[0].id,
            merged: wr.rows[0].created_at < h.created_at });
        }
      }
    }
    // 只有扩容量才可能产生新的递补；减容量后已有候补继续等待。
    const promoted = newCapacity > session.capacity
      ? await promoteWaitlist(client, sessionId, newCapacity)
      : [];
    return { capacity: newCapacity, displaced, promoted };
  });
}

// ---------- 活动改期 ----------
async function reschedule(sessionId, startAt, endAt) {
  return db.withTx(async (client) => {
    const start = new Date(startAt);
    const end = new Date(endAt);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
      throw new ApiError(400, 'BAD_SCHEDULE', '开始时间必须早于结束时间。');
    }
    await getSessionLocked(client, sessionId);
    const r = await client.query(
      `UPDATE sessions SET start_at=$2, end_at=$3, schedule_version=schedule_version+1
        WHERE id=$1 RETURNING *`,
      [sessionId, startAt, endAt]
    );
    return r.rows[0];
  });
}

// 只读可用性视图
async function availability(sessionId) {
  const r = await db.query(
    `SELECT s.id, s.title, s.capacity, s.start_at, s.end_at, s.schedule_version,
            (SELECT count(*) FROM enrollments WHERE session_id=s.id AND status='confirmed') AS confirmed,
            (SELECT count(*) FROM holds WHERE session_id=s.id AND status='active' AND expires_at > now()) AS held
       FROM sessions s WHERE s.id=$1`,
    [sessionId]
  );
  if (!r.rows[0]) throw new ApiError(404, 'SESSION_NOT_FOUND', '课次不存在。');
  const row = r.rows[0];
  return { ...row, remaining: Math.max(0, row.capacity - row.confirmed - row.held) };
}

module.exports = {
  createHold, confirmHold, releaseHold, cancelEnrollment, sweep,
  setCapacity, reschedule, availability, counts,
};
