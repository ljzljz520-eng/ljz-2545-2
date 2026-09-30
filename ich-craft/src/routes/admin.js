'use strict';
const express = require('express');
const db = require('../db');
const seats = require('../services/seats');
const content = require('../services/content');
const idempotency = require('../middleware/idempotency');
const { asyncHandler, ApiError } = require('../util');

const router = express.Router();

// 演示用管理口令：X-Admin-Key，默认值仅用于本地；生产经环境变量注入
router.use((req, res, next) => {
  const key = req.get('x-admin-key');
  if (!key || key !== (process.env.ADMIN_KEY || 'dev-admin-key')) {
    throw new ApiError(401, 'ADMIN_UNAUTHORIZED', '需要管理员口令（X-Admin-Key）。');
  }
  next();
});

// 总览：课次席位与授权一览
router.get('/overview', asyncHandler(async (_req, res) => {
  const sessions = (await db.query(
    `SELECT s.*,
        (SELECT count(*) FROM enrollments WHERE session_id=s.id AND status='confirmed') AS confirmed,
        (SELECT count(*) FROM holds WHERE session_id=s.id AND status='active' AND expires_at>now()) AS held,
        (SELECT count(*) FROM waitlist_entries WHERE session_id=s.id AND status='waiting') AS waiting
       FROM sessions s ORDER BY s.start_at`
  )).rows;
  const grants = (await db.query(
    `SELECT g.*, w.title AS work_title FROM grants g JOIN works w ON w.id=g.work_id
      ORDER BY g.created_at DESC`
  )).rows.map((g) => ({
    ...g,
    effective: g.status === 'active' && (!g.expires_at || new Date(g.expires_at) > new Date()),
  }));
  const works = (await db.query(
    `SELECT w.id, w.slug, w.title, w.published_version_id,
            (SELECT max(version_no) FROM work_versions WHERE work_id=w.id) AS latest_version
       FROM works w ORDER BY w.created_at`
  )).rows;
  res.json({ sessions, grants, works });
}));

// 新建课次
router.post('/sessions', asyncHandler(async (req, res) => {
  const { title, location, start_at, end_at, capacity, craft_id, work_id } = req.body;
  if (!title || !start_at || !end_at || capacity == null) {
    throw new ApiError(400, 'BAD_SESSION', '缺少课次必要字段。');
  }
  const r = await db.query(
    `INSERT INTO sessions (title, location, start_at, end_at, capacity, craft_id, work_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [title, location || null, start_at, end_at, capacity, craft_id || null, work_id || null]
  );
  res.status(201).json(r.rows[0]);
}));

// 调整容量（减容量见 seats 服务规则）
router.patch('/sessions/:id/capacity', asyncHandler(async (req, res) => {
  const result = await seats.setCapacity(req.params.id, parseInt(req.body.capacity, 10));
  res.json(result);
}));

// 活动改期（不删除任何报名，前端据 schedule_version 提示）
router.patch('/sessions/:id/reschedule', asyncHandler(async (req, res) => {
  const { start_at, end_at } = req.body;
  if (!start_at || !end_at) throw new ApiError(400, 'BAD_SCHEDULE', '缺少新的起止时间。');
  const session = await seats.reschedule(req.params.id, start_at, end_at);
  res.json({ ...session, note: '改期完成：已有报名全部保留，报名人页面会看到改期提示。' });
}));

// 授权：授予 / 撤回
router.post('/grants', asyncHandler(async (req, res) => {
  const { work_id, scope, expires_at } = req.body;
  if (!['display', 'teaching'].includes(scope)) {
    throw new ApiError(400, 'BAD_SCOPE', '授权用途只能是 display 或 teaching。');
  }
  const g = await content.grant({ work_id, scope, expires_at });
  res.status(201).json(g);
}));

router.post('/grants/:id/revoke', asyncHandler(async (req, res) => {
  const g = await content.revoke(req.params.id, req.body.reason);
  res.json({ ...g,
    note: g.scope === 'display'
      ? '展示授权已撤回：线上图片立即下线；教学授权与课程记录不受影响。'
      : '教学授权已撤回：步骤内容停止开放；展示授权与课程记录不受影响。' });
}));

// 素材登记 + 作品换图（草稿）
router.post('/assets', asyncHandler(async (req, res) => {
  const { url, alt, mime } = req.body;
  if (!url) throw new ApiError(400, 'BAD_ASSET', '缺少素材 url。');
  const r = await db.query(
    'INSERT INTO assets (url, alt, mime) VALUES ($1,$2,$3) RETURNING *',
    [url, alt || null, mime || 'image/svg+xml']
  );
  res.status(201).json(r.rows[0]);
}));

router.post('/works/:id/swap-cover', asyncHandler(async (req, res) => {
  res.json(await content.swapCover(req.params.id, req.body.asset_id));
}));

// 发布新版本
router.post('/works/:id/publish', asyncHandler(async (req, res) => {
  const v = await content.publishWork(req.params.id, req.body.note);
  res.status(201).json(v);
}));

// 授权事件流水
router.get('/grant-events', asyncHandler(async (_req, res) => {
  const r = await db.query(
    `SELECT ge.*, g.scope, g.work_id FROM grant_events ge
       JOIN grants g ON g.id=ge.grant_id ORDER BY ge.created_at DESC LIMIT 100`);
  res.json({ events: r.rows });
}));

module.exports = router;
