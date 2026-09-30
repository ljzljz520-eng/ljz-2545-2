'use strict';
const express = require('express');
const db = require('../db');
const content = require('../services/content');
const seats = require('../services/seats');
const { asyncHandler, ApiError } = require('../util');

const router = express.Router();

// 首页：技艺列表
router.get('/crafts', asyncHandler(async (_req, res) => {
  const r = await db.query(
    `SELECT c.id, c.slug, c.name, c.tagline, c.region,
            CASE WHEN display.has_active THEN a.url END AS cover_url,
            CASE WHEN display.has_active THEN a.alt END AS cover_alt,
            (SELECT count(*) FROM works w WHERE w.craft_id=c.id) AS work_count
       FROM crafts c
       CROSS JOIN LATERAL (
         SELECT EXISTS (
           SELECT 1 FROM works w
             JOIN grants g ON g.work_id=w.id
            WHERE w.craft_id=c.id AND g.scope='display'
              AND g.status='active'
              AND (g.expires_at IS NULL OR g.expires_at > now())
         ) AS has_active
       ) display
       LEFT JOIN assets a ON a.id=c.cover_asset_id
      ORDER BY c.created_at`
  );
  res.json({ crafts: r.rows });
}));

// 技艺详情 + 代表作品
router.get('/crafts/:slug', asyncHandler(async (req, res) => {
  const r = await db.query(
    `SELECT c.*,
            CASE WHEN display.has_active THEN a.url END AS cover_url
       FROM crafts c
       CROSS JOIN LATERAL (
         SELECT EXISTS (
           SELECT 1 FROM works w
             JOIN grants g ON g.work_id=w.id
            WHERE w.craft_id=c.id AND g.scope='display'
              AND g.status='active'
              AND (g.expires_at IS NULL OR g.expires_at > now())
         ) AS has_active
       ) display
       LEFT JOIN assets a ON a.id=c.cover_asset_id
      WHERE c.slug=$1`,
    [req.params.slug]
  );
  if (!r.rows[0]) throw new ApiError(404, 'CRAFT_NOT_FOUND', '技艺不存在。');
  const craft = r.rows[0];
  const mats = await db.query(
    'SELECT name, origin, usage FROM materials WHERE craft_id=$1 ORDER BY sort', [craft.id]
  );
  const inheritors = await db.query(
    `SELECT i.name, i.title, i.region, i.bio, a.url AS portrait_url
       FROM craft_inheritors ci JOIN inheritors i ON i.id=ci.inheritor_id
       LEFT JOIN assets a ON a.id=i.portrait_asset_id
      WHERE ci.craft_id=$1`, [craft.id]
  );
  const works = await db.query(
    `SELECT w.id, w.slug, w.title, w.summary,
            v.snapshot->>'cover_asset_id' AS cover_asset_id
       FROM works w JOIN work_versions v ON v.id=w.published_version_id
      WHERE w.craft_id=$1 ORDER BY w.created_at`, [craft.id]
  );
  // 逐个判断展示授权，未授权的作品只返回元信息（图不返回）
  const list = [];
  for (const w of works.rows) {
    const st = await content.grantState(db, w.id);
    let cover = null;
    if (st.display.status === 'active' && w.cover_asset_id) {
      const a = await db.query('SELECT url, alt FROM assets WHERE id=$1', [w.cover_asset_id]);
      cover = a.rows[0] || null;
    }
    list.push({ slug: w.slug, title: w.title, summary: w.summary, cover,
      display: st.display });
  }
  res.json({ craft, materials: mats.rows, inheritors: inheritors.rows, works: list });
}));

// 作品故事页
router.get('/works/:slug', asyncHandler(async (req, res) => {
  res.json(await content.getStory(req.params.slug));
}));

// 可参加课次列表（突出剩余可报名额）
router.get('/sessions', asyncHandler(async (_req, res) => {
  const r = await db.query(
    `SELECT s.id, s.title, s.start_at, s.end_at, s.location, s.capacity,
            s.schedule_version, c.name AS craft_name, w.title AS work_title, w.slug AS work_slug,
            (SELECT count(*) FROM enrollments WHERE session_id=s.id AND status='confirmed') AS confirmed,
            (SELECT count(*) FROM holds WHERE session_id=s.id AND status='active' AND expires_at>now()) AS held
       FROM sessions s
       LEFT JOIN crafts c ON c.id=s.craft_id
       LEFT JOIN works w ON w.id=s.work_id
      WHERE s.end_at > now()
      ORDER BY s.start_at`
  );
  const sessions = r.rows.map((s) => ({
    ...s,
    remaining: Math.max(0, s.capacity - s.confirmed - s.held),
    seat_note:
      (s.confirmed + s.held >= s.capacity)
        ? '名额已满：可候补，有人取消时按顺序递补。'
        : `剩余 ${Math.max(0, s.capacity - s.confirmed - s.held)} 个可报名额（报名后为你短暂保留）。`,
  }));
  res.json({ sessions,
    policy: { hold_ttl_ms: require('../config').holdTtlMs,
              invite_ttl_ms: require('../config').inviteTtlMs,
              explanation: '提交报名后服务端短暂保留名额；在保留期内确认才算报名成功。' } });
}));

router.get('/sessions/:id', asyncHandler(async (req, res) => {
  res.json(await seats.availability(req.params.id));
}));

module.exports = router;
