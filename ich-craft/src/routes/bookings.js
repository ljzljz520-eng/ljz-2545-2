'use strict';
const express = require('express');
const db = require('../db');
const seats = require('../services/seats');
const idempotency = require('../middleware/idempotency');
const { asyncHandler, ApiError } = require('../util');

const router = express.Router();

function requireBooking(body) {
  const name = String(body.name || '').trim();
  const contact = String(body.contact || '').trim();
  if (!name || !contact) {
    throw new ApiError(400, 'MISSING_CONTACT', '请填写姓名与联系方式。');
  }
  return { name, contact: contact.toLowerCase() };
}

// 步骤 1：提交报名 → 短暂占位（或进入候补）
router.post('/sessions/:id/holds', idempotency(), asyncHandler(async (req, res) => {
  const { name, contact } = requireBooking(req.body);
  const result = await seats.createHold({
    session_id: req.params.id, name, contact,
  });
  const status = result.outcome === 'waitlisted' ? 202 : 201;
  res.status(status).json({ ...result,
    hint: result.outcome === 'waitlisted'
      ? '当前没有空位，已进入候补队列；有名额时将按顺序为你短暂保留。'
      : '名额已为你短暂保留，请尽快确认（超时自动回收）。' });
}));

// 步骤 2：确认占位 → 报名成功
router.post('/holds/:id/confirm', idempotency(), asyncHandler(async (req, res) => {
  const contact = req.body.contact ? String(req.body.contact).trim().toLowerCase() : null;
  const result = await seats.confirmHold(req.params.id, contact);
  res.json(result);
}));

// 主动放弃尚未确认的占位（立即释放并递补）
router.post('/holds/:id/release', idempotency(), asyncHandler(async (req, res) => {
  const contact = req.body.contact ? String(req.body.contact).trim().toLowerCase() : null;
  const result = await seats.releaseHold(req.params.id, contact);
  res.json(result);
}));

// 取消报名（释放名额，触发候补递补）
router.post('/enrollments/:id/cancel', idempotency(), asyncHandler(async (req, res) => {
  const result = await seats.cancelEnrollment(req.params.id, req.body.reason);
  res.json(result);
}));

// 我的报名（按联系方式查询，含改期提示）
router.get('/my-enrollments', asyncHandler(async (req, res) => {
  const contact = String(req.query.contact || '').trim().toLowerCase();
  if (!contact) throw new ApiError(400, 'MISSING_CONTACT', '请提供联系方式。');
  const r = await db.query(
    `SELECT e.*, s.title, s.start_at AS current_start_at, s.end_at AS current_end_at,
            s.location, s.schedule_version, c.name AS craft_name
       FROM enrollments e
       JOIN sessions s ON s.id=e.session_id
       LEFT JOIN crafts c ON c.id=s.craft_id
      WHERE e.contact=$1 ORDER BY e.created_at DESC`, [contact]);
  const list = r.rows.map((e) => ({
    ...e,
    schedule_changed: e.schedule_version !== e.schedule_version_at_booking,
    note: (e.status === 'cancelled')
      ? '该报名已取消；历史记录保留。'
      : (e.schedule_version !== e.schedule_version_at_booking
          ? '活动已改期，请留意新课表（原报名记录保留）。'
          : null),
  }));
  res.json({ enrollments: list });
}));

// 候补状态查询
router.get('/waitlist', asyncHandler(async (req, res) => {
  const contact = String(req.query.contact || '').trim().toLowerCase();
  const sessionId = req.query.session_id;
  const params = [contact];
  let where = 'contact=$1';
  if (sessionId) { params.push(sessionId); where += ' AND session_id=$2'; }
  const r = await db.query(
    `SELECT w.*, s.title FROM waitlist_entries w
       JOIN sessions s ON s.id=w.session_id
      WHERE ${where} ORDER BY w.created_at DESC`, params);
  res.json({ entries: r.rows });
}));

module.exports = router;
