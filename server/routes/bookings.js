import { Router } from 'express';
import { query } from '../db.js';
import { createBooking, confirmBooking, cancelBooking, seatSummary, SeatError } from '../lib/seats.js';
import { config } from '../config.js';

const router = Router();

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// 报名（创建短暂占位或进候补）
router.post('/', wrap(async (req, res) => {
  const { course_id, student_name, student_contact, idempotency_key } = req.body || {};
  const result = await createBooking({
    courseId: course_id, name: student_name, contact: student_contact, idempotencyKey: idempotency_key,
  });
  const b = result.booking;
  const seats = await seatSummary(b.course_id);
  const action = b.status === 'held' ? 'confirm_within_hold' : 'wait_for_promotion';
  res.status(result.retried ? 200 : 201).json({
    data: {
      booking: serialize(b),
      seat_state: b.status === 'held'
        ? '席位已为你短暂保留，请在倒计时内确认；超时将自动释放并按候补顺序递补。'
        : b.status === 'waitlisted'
          ? '当前名额已满，你已进入候补队列；有名额释放时将按顺序获得短暂保留。'
          : '已确认报名。',
      next_action: action,
      hold_seconds: config.holdSeconds,
      retried: result.retried || false,
    },
    seats,
  });
}));

router.post('/:id/confirm', wrap(async (req, res) => {
  const result = await confirmBooking(req.params.id, req.body?.student_contact, req.body?.idempotency_key);
  const seats = await seatSummary(result.booking.course_id);
  res.json({ data: { booking: serialize(result.booking), retried: result.retried, seat_state: '报名已确认，席位锁定。' }, seats });
}));

router.post('/:id/cancel', wrap(async (req, res) => {
  const result = await cancelBooking(req.params.id, req.body?.student_contact, req.body?.idempotency_key);
  const seats = await seatSummary(result.booking.course_id);
  res.json({ data: {
    booking: serialize(result.booking), retried: result.retried,
    promoted: (result.promoted || []).map(serialize),
    seat_state: '已取消。' + ((result.promoted||[]).length ? `候补第 1 位已获得 ${config.holdSeconds} 秒短暂保留。` : ''),
  }, seats });
}));

router.get('/:id', wrap(async (req, res) => {
  const { rows } = await query(`SELECT * FROM bookings WHERE id=$1`, [req.params.id]);
  const b = rows[0];
  if (!b) return res.status(404).json({ error: 'not_found', message: '订单不存在' });
  const { rows: events } = await query(`SELECT type,detail,created_at FROM booking_events WHERE booking_id=$1 ORDER BY created_at`, [b.id]);
  const seats = await seatSummary(b.course_id);
  res.json({ data: { booking: serialize(b), events, snapshot: b.course_snapshot }, seats });
}));

// 我的报名（跨浏览器：手机号/邮箱识别）
router.get('/by-contact/:contact', wrap(async (req, res) => {
  const { rows } = await query(`
    SELECT b.*, c.title AS course_title, c.slug AS course_slug, c.starts_at AS course_starts_at,
           c.schedule_version AS course_schedule_version, c.status AS course_status
    FROM bookings b JOIN courses c ON c.id=b.course_id
    WHERE b.student_contact=$1
    ORDER BY b.created_at DESC`, [req.params.contact]);
  res.json({ data: rows.map(serialize) });
}));

// 轮询：候补/占位状态（前端在“断网恢复”与倒计时期间使用）
router.get('/:id/poll', wrap(async (req, res) => {
  const { rows } = await query(`
    SELECT id,status,hold_expires_at,waitlist_seq FROM bookings WHERE id=$1`, [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'not_found' });
  const seats = await seatSummary(req.params.id);
  res.json({ data: rows[0], server_time: new Date().toISOString(), seats });
}));

export function serialize(b) {
  return {
    id: b.id, course_id: b.course_id, student_name: b.student_name,
    student_contact: b.student_contact, status: b.status,
    hold_expires_at: b.hold_expires_at, waitlist_seq: Number(b.waitlist_seq),
    course_snapshot: b.course_snapshot, created_at: b.created_at,
    confirmed_at: b.confirmed_at, cancelled_at: b.cancelled_at,
    course_title: b.course_title, course_slug: b.course_slug,
    course_starts_at: b.course_starts_at, course_schedule_version: b.course_schedule_version,
    course_status: b.course_status,
  };
}

// 错误映射
export function bookingErrorHandler(err, req, res, next) {
  if (err instanceof SeatError) return res.status(err.status).json(err.body);
  next(err);
}

export default router;
