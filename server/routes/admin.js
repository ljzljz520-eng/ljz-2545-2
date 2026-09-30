import { Router } from 'express';
import { query } from '../db.js';
import { setCapacity, rescheduleCourse, swapWorkImage, setLicenseStatus, updateTeachingStep } from '../lib/admin.js';
import { seatSummary, sweepExpiredHolds } from '../lib/seats.js';
import { config } from '../config.js';

const router = Router();

router.use((req, res, next) => {
  const token = req.get('x-admin-token') || req.query.token;
  if (token !== config.adminToken) return res.status(401).json({ error: 'unauthorized', message: '需要管理员令牌（X-Admin-Token）' });
  next();
});

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

router.post('/courses/:id/capacity', wrap(async (req, res) => {
  const r = await setCapacity({ courseId: req.params.id, capacity: req.body?.capacity, actor: req.body?.actor || 'admin' });
  res.json({ data: r, seats: await seatSummary(req.params.id) });
}));

router.post('/courses/:id/reschedule', wrap(async (req, res) => {
  const r = await rescheduleCourse({
    courseId: req.params.id, startsAt: req.body?.starts_at, endsAt: req.body?.ends_at,
    actor: req.body?.actor || 'admin',
  });
  res.json({ data: r, seats: await seatSummary(req.params.id) });
}));

router.post('/works/:id/swap-image', wrap(async (req, res) => {
  const r = await swapWorkImage({
    workId: req.params.id, assetUrl: req.body?.asset_url, note: req.body?.note,
    actor: req.body?.actor || 'admin',
  });
  res.json({ data: r });
}));

router.post('/licenses', wrap(async (req, res) => {
  const r = await setLicenseStatus({
    licensorId: req.body?.licensor_id, subjectType: req.body?.subject_type,
    subjectId: req.body?.subject_id, purpose: req.body?.purpose,
    status: req.body?.status, scopeNote: req.body?.scope_note, expiresAt: req.body?.expires_at,
    actor: req.body?.actor || 'admin',
  });
  res.json({ data: r });
}));

router.post('/steps/:id/teaching', wrap(async (req, res) => {
  const r = await updateTeachingStep({
    stepId: req.params.id, teachingText: req.body?.teaching_text, teachingTip: req.body?.teaching_tip,
    actor: req.body?.actor || 'admin',
  });
  res.json({ data: r });
}));

// 管理视图：订单列表与审计、版本
router.get('/courses/:id/bookings', wrap(async (req, res) => {
  const { rows } = await query(
    `SELECT id,student_name,student_contact,status,hold_expires_at,waitlist_seq,created_at,confirmed_at,cancelled_at
     FROM bookings WHERE course_id=$1 ORDER BY created_at`, [req.params.id]);
  res.json({ data: rows, seats: await seatSummary(req.params.id) });
}));

router.get('/audit', wrap(async (req, res) => {
  const { rows } = await query(`SELECT * FROM audit_events ORDER BY created_at DESC LIMIT 100`);
  res.json({ data: rows });
}));

router.post('/maintenance/sweep', wrap(async (req, res) => {
  const n = await sweepExpiredHolds();
  res.json({ data: { swept_courses: n, at: new Date().toISOString() } });
}));

// 错误映射
router.use((err, req, res, next) => {
  const status = err.status || 500;
  res.status(status).json(err.body || { error: 'server_error', message: err.message });
});

export default router;
