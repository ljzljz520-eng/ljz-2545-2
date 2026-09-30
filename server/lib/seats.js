import { query, withTransaction } from '../db.js';
import { config } from '../config.js';

const ACTIVE = ['held', 'confirmed', 'waitlisted'];

export class SeatError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    this.status = extra.status || 409;
    this.body = { error: code, message, ...extra };
  }
}

const snapshot = (c) => ({
  course_id: c.id,
  title: c.title,
  slug: c.slug,
  starts_at: c.starts_at instanceof Date ? c.starts_at.toISOString() : c.starts_at,
  ends_at: c.ends_at instanceof Date ? c.ends_at.toISOString() : c.ends_at,
  location: c.location,
  schedule_version: c.schedule_version,
  status: c.status,
  captured_at: new Date().toISOString(),
});

async function logEvent(client, bookingId, type, detail = {}) {
  await client.query(
    `INSERT INTO booking_events (booking_id, type, detail) VALUES ($1,$2,$3)`,
    [bookingId, type, JSON.stringify(detail)]
  );
}

/** 真实席位计数（锁课次行后统计），避免“两个浏览器各自看到最后名额” */
async function countsFor(client, courseId, txNow) {
  const { rows: cRows } = await client.query(
    `SELECT * FROM courses WHERE id=$1 FOR UPDATE`, [courseId]
  );
  const course = cRows[0];
  if (!course) throw new SeatError('course_not_found', '课次不存在', { status: 404 });

  // 顺手回收本事务视角下已超时的占位（幂等：与后台 sweeper 同样安全）
  const expired = await client.query(`
    UPDATE bookings SET status='expired', hold_expires_at=NULL, cancelled_at=NULL
    WHERE course_id=$1 AND status='held' AND hold_expires_at <= $2
    RETURNING id`, [courseId, txNow]);
  for (const e of expired.rows) await logEvent(client, e.id, 'expired', { at: txNow.toISOString(), by: 'transaction' });

  const { rows } = await client.query(`
    SELECT status, count(*)::int AS n FROM bookings
    WHERE course_id=$1 AND status IN ('held','confirmed','waitlisted')
    GROUP BY status`, [courseId]);
  const n = { held: 0, confirmed: 0, waitlisted: 0 };
  rows.forEach((r) => { n[r.status] = r.n; });
  n.reserved = n.held + n.confirmed;
  n.free = Math.max(0, course.capacity - n.reserved);
  return { course, n };
}

/**
 * 报名：先短暂保留（held），无余量则进候补（waitlisted）。
 * 方案选择：预约保留（hold-then-confirm）。与“实时扣减”的比较见 docs/api.md 与页面说明。
 */
export async function createBooking(input) {
  const { courseId, name, contact, idempotencyKey } = input;
  if (!courseId || !name || !contact || !idempotencyKey) {
    throw new SeatError('bad_request', '缺少必填字段', { status: 400 });
  }

  return withTransaction(async (client) => {
    const now = new Date();
    // 幂等：相同 key（断网重试）直接返回原结果
    const dup = await client.query(`SELECT * FROM bookings WHERE idempotency_key=$1`, [idempotencyKey]);
    if (dup.rows[0]) {
      const b = dup.rows[0];
      if (b.course_id !== courseId) throw new SeatError('key_reuse', '同一报名令牌不能用于不同课次', { status: 400 });
      return { booking: b, retried: true };
    }

    const { course, n } = await countsFor(client, courseId, now);
    if (course.status === 'canceled') throw new SeatError('course_canceled', '课次已取消');

    // 同一学员已有活跃订单（跨浏览器/跨标签重复报名拦截）
    const same = await client.query(
      `SELECT id, status FROM bookings WHERE course_id=$1 AND student_contact=$2
       AND status = ANY($3) LIMIT 1`, [courseId, contact, ACTIVE]
    );
    if (same.rows[0]) {
      throw new SeatError('already_enrolled', '你已报名该课次，请勿重复提交',
        { existing_booking_id: same.rows[0].id, existing_status: same.rows[0].status });
    }

    let status, holdExpires = null;
    if (n.free > 0 && course.status === 'scheduled') {
      status = 'held';
      holdExpires = new Date(now.getTime() + config.holdSeconds * 1000);
    } else {
      status = 'waitlisted';
    }
    const { rows } = await client.query(`
      INSERT INTO bookings (course_id, student_name, student_contact, status, hold_expires_at, idempotency_key, course_snapshot)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [courseId, name, contact, status, holdExpires, idempotencyKey, JSON.stringify(snapshot(course))]);
    const b = rows[0];
    await logEvent(client, b.id, status, { at: now.toISOString(), hold_seconds: config.holdSeconds });
    return { booking: b, retried: false };
  });
}

/** 确认占位（学员在超时内完成确认） */
export async function confirmBooking(bookingId, contact, idempotencyKey) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT * FROM bookings WHERE id=$1`, [bookingId]);
    const b = rows[0];
    if (!b) throw new SeatError('booking_not_found', '报名记录不存在', { status: 404 });
    if (contact && b.student_contact !== contact) throw new SeatError('forbidden', '无权操作该订单', { status: 403 });
    if (idempotencyKey) {
      const d = await client.query(`SELECT id FROM booking_events WHERE booking_id=$1 AND type='confirmed' AND detail->>'idempotency_key'=$2`, [bookingId, idempotencyKey]);
      if (d.rows[0]) return { booking: b, retried: true };
    }
    const now = new Date();
    if (b.status === 'confirmed') return { booking: b, retried: true };
    if (b.status !== 'held') throw new SeatError('not_held', `当前状态为「${b.status}」，无法确认`);
    if (b.hold_expires_at && new Date(b.hold_expires_at) <= now) {
      // 确认途中发现已过期：标记过期并尝试晋升候补
      await client.query(`UPDATE bookings SET status='expired', hold_expires_at=NULL WHERE id=$1`, [bookingId]);
      await logEvent(client, bookingId, 'expired', { at: now.toISOString(), by: 'confirm_attempt' });
      await promote(client, b.course_id, now);
      throw new SeatError('hold_expired', '占位已超时，名额已释放并按候补顺序递补');
    }
    const { rows: upd } = await client.query(`
      UPDATE bookings SET status='confirmed', hold_expires_at=NULL, confirmed_at=COALESCE(confirmed_at,$2)
      WHERE id=$1 AND status='held' RETURNING *`, [bookingId, now]);
    if (!upd[0]) throw new SeatError('race_lost', '确认失败，名额状态已变化');
    await logEvent(client, bookingId, 'confirmed', { at: now.toISOString(), idempotency_key: idempotencyKey || null });
    return { booking: upd[0], retried: false };
  });
}

/** 取消：held/confirmed/waitlisted 均可取消；随后候补顺序晋升 */
export async function cancelBooking(bookingId, contact, idempotencyKey) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT * FROM bookings WHERE id=$1`, [bookingId]);
    const b = rows[0];
    if (!b) throw new SeatError('booking_not_found', '报名记录不存在', { status: 404 });
    if (contact && b.student_contact !== contact) throw new SeatError('forbidden', '无权操作该订单', { status: 403 });
    if (idempotencyKey) {
      const d = await client.query(`SELECT id FROM booking_events WHERE booking_id=$1 AND type='cancelled' AND detail->>'idempotency_key'=$2`, [bookingId, idempotencyKey]);
      if (d.rows[0]) return { booking: b, retried: true };
    }
    if (b.status === 'cancelled') return { booking: b, retried: true };
    if (b.status === 'expired') throw new SeatError('already_expired', '订单已过期，无需取消');
    const before = b.status;
    const { rows: upd } = await client.query(`
      UPDATE bookings SET status='cancelled', cancelled_at=$2, hold_expires_at=NULL
      WHERE id=$1 RETURNING *`, [bookingId, new Date()]);
    await logEvent(client, bookingId, 'cancelled', { from: before, idempotency_key: idempotencyKey || null });
    const promoted = before === 'confirmed' ? await promote(client, b.course_id, new Date()) : [];
    return { booking: upd[0], promoted, retried: false };
  });
}

/**
 * 候补晋升：取消/过期让出名额后，按 waitlist_seq 最前者晋升为 held 并短暂保留。
 * 注意“管理员减容量”场景：没有空位则不晋升（绝不超卖）。
 */
async function promote(client, courseId, now) {
  const promoted = [];
  const { course, n } = await countsFor(client, courseId, now);
  if (course.status !== 'scheduled') return promoted;
  let free = n.free;
  while (free > 0) {
    const { rows } = await client.query(`
      SELECT * FROM bookings
      WHERE course_id=$1 AND status='waitlisted'
      ORDER BY waitlist_seq ASC
      LIMIT 1 FOR UPDATE SKIP LOCKED`, [courseId]);
    if (!rows[0]) break;
    const w = rows[0];
    const holdExpires = new Date(now.getTime() + config.holdSeconds * 1000);
    const { rows: upd } = await client.query(`
      UPDATE bookings SET status='held', hold_expires_at=$2
      WHERE id=$1 AND status='waitlisted' RETURNING *`, [w.id, holdExpires]);
    if (!upd[0]) continue;
    await logEvent(client, w.id, 'promoted', { at: now.toISOString(), hold_seconds: config.holdSeconds });
    promoted.push(upd[0]);
    free -= 1;
  }
  return promoted;
}

/** 后台定时：回收所有过期占位；回收产生空位则晋升候补 */
export async function sweepExpiredHolds() {
  const expiredCourses = new Set();
  await withTransaction(async (client) => {
    const now = new Date();
    const { rows } = await client.query(`
      UPDATE bookings SET status='expired', hold_expires_at=NULL
      WHERE status='held' AND hold_expires_at <= now()
      RETURNING id, course_id`);
    for (const r of rows) {
      await logEvent(client, r.id, 'expired', { at: now.toISOString(), by: 'sweeper' });
      expiredCourses.add(r.course_id);
    }
  });
  for (const cid of expiredCourses) {
    await withTransaction((client) => promote(client, cid, new Date())).catch((e) =>
      console.error('promote after sweep failed', cid, e.message));
  }
  return expiredCourses.size;
}

/** 公开查询用的席位视图（非锁定，供展示） */
export async function seatSummary(courseId) {
  const now = new Date();
  const { rows: c } = await query(`SELECT * FROM courses WHERE id=$1`, [courseId]);
  const course = c[0];
  if (!course) return null;
  const { rows } = await query(`
    SELECT status, count(*)::int n FROM bookings
    WHERE course_id=$1 AND status IN ('held','confirmed','waitlisted')
      AND (status <> 'held' OR hold_expires_at > $2)
    GROUP BY status`, [courseId, now]);
  const n = { held: 0, confirmed: 0, waitlisted: 0 };
  rows.forEach((r) => { n[r.status] = r.n; });
  const liveReserved = n.held + n.confirmed;
  return {
    capacity: course.capacity,
    held: n.held,
    confirmed: n.confirmed,
    waitlisted: n.waitlisted,
    reserved: liveReserved,
    free: Math.max(0, course.capacity - liveReserved),
    hold_seconds: config.holdSeconds,
  };
}
