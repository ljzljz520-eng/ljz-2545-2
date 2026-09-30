import { Router } from 'express';
import { query } from '../db.js';
import { seatSummary } from '../lib/seats.js';
import { loadLicenseMap, licKey } from '../lib/license.js';

const router = Router();

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await query(`
      SELECT c.*, w.slug AS work_slug, w.title AS work_title, w.cover_url AS work_cover,
             i.name AS inheritor_name
      FROM courses c
      JOIN works w ON w.id=c.work_id
      JOIN inheritors i ON i.id=c.inheritor_id
      ORDER BY c.starts_at`);
    const keys = rows.map((c) => ({ subject_type: 'work', subject_id: c.work_id, purpose: 'display' }));
    const lmap = await loadLicenseMap(keys);
    const data = [];
    for (const c of rows) {
      const seats = await seatSummary(c.id);
      const lic = lmap.get(licKey('work', c.work_id, 'display'));
      data.push({
        id: c.id, slug: c.slug, title: c.title, description: c.description, location: c.location,
        starts_at: c.starts_at, ends_at: c.ends_at, status: c.status,
        schedule_version: c.schedule_version, original_starts_at: c.original_starts_at,
        work: { slug: c.work_slug, title: c.work_title, cover: lic.state === 'active' ? c.work_cover : null, display: lic.state },
        inheritor_name: c.inheritor_name,
        seats,
      });
    }
    res.json({ data, hold_seconds: seats0(data) });
  } catch (e) { next(e); }
});
function seats0(d){ return d[0]?.seats?.hold_seconds ?? 60; }

router.get('/:slug', async (req, res, next) => {
  try {
    const { rows } = await query(`
      SELECT c.*, w.slug AS work_slug, w.title AS work_title, i.name AS inheritor_name
      FROM courses c JOIN works w ON w.id=c.work_id JOIN inheritors i ON i.id=c.inheritor_id
      WHERE c.slug=$1`, [req.params.slug]);
    const c = rows[0];
    if (!c) return res.status(404).json({ error: 'not_found', message: '课次不存在' });
    const seats = await seatSummary(c.id);
    const { rows: versions } = await query(`
      SELECT version,snapshot,change_note,published_by,created_at
      FROM published_versions WHERE entity_type='course' AND entity_id=$1 ORDER BY version DESC`, [c.id]);
    res.json({
      data: {
        id: c.id, slug: c.slug, title: c.title, description: c.description, location: c.location,
        starts_at: c.starts_at, ends_at: c.ends_at, capacity: c.capacity,
        status: c.status, schedule_version: c.schedule_version, original_starts_at: c.original_starts_at,
        work: { slug: c.work_slug, title: c.work_title }, inheritor_name: c.inheritor_name,
        seats, versions,
      },
    });
  } catch (e) { next(e); }
});

export default router;
