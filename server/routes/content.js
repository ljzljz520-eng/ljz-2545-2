import { Router } from 'express';
import { query } from '../db.js';
import { loadLicenseMap, licKey, canViewTeaching } from '../lib/license.js';

const router = Router();

const reasonFor = (state) => ({
  withdrawn: { code: 'withdrawn', title: '展示许可已撤回', detail: '传承人撤回了该素材的公开展示许可；记录保留，素材停止公开。' },
  expired:   { code: 'expired', title: '授权已到期', detail: '该项授权约定期限已过，暂不可用；历史课程记录不受影响。' },
  missing:   { code: 'missing', title: '未取得授权', detail: '该素材尚未取得对应用途的传承人授权。' },
}[state] || null);

router.get('/inheritors', async (req, res, next) => {
  try {
    const { rows } = await query(`SELECT id,name,title,region,bio,portrait_url FROM inheritors ORDER BY created_at`);
    res.json({ data: rows });
  } catch (e) { next(e); }
});

router.get('/works', async (req, res, next) => {
  try {
    const { rows } = await query(`
      SELECT w.id,w.slug,w.title,w.subtitle,w.summary,w.cover_url,w.published_version,
             i.name AS inheritor_name, i.id AS inheritor_id
      FROM works w JOIN inheritors i ON i.id=w.inheritor_id
      ORDER BY w.created_at`);
    const keys = rows.map((w) => ({ subject_type: 'work', subject_id: w.id, purpose: 'display' }));
    const lmap = await loadLicenseMap(keys);
    const data = rows.map((w) => {
      const l = lmap.get(licKey('work', w.id, 'display'));
      const available = l.state === 'active';
      return {
        ...w,
        display: available ? 'available' : l.state,
        availability: available
          ? { available: true }
          : { available: false, ...reasonFor(l.state), license: l },
      };
    });
    res.json({ data });
  } catch (e) { next(e); }
});

router.get('/works/:slug', async (req, res, next) => {
  try {
    const contact = String(req.query.contact || '');
    const { rows } = await query(`
      SELECT w.*, i.id AS inheritor_id, i.name AS inheritor_name, i.title AS inheritor_title,
             i.region AS inheritor_region, i.bio AS inheritor_bio, i.portrait_url AS inheritor_portrait
      FROM works w JOIN inheritors i ON i.id=w.inheritor_id
      WHERE w.slug=$1`, [req.params.slug]);
    const w = rows[0];
    if (!w) return res.status(404).json({ error: 'not_found', message: '作品不存在' });

    const lmap = await loadLicenseMap([
      { subject_type: 'work', subject_id: w.id, purpose: 'display' },
      { subject_type: 'work', subject_id: w.id, purpose: 'teaching' },
    ]);
    const displayLic = lmap.get(licKey('work', w.id, 'display'));
    const teachingLic = lmap.get(licKey('work', w.id, 'teaching'));
    const displayOk = displayLic.state === 'active';

    // 材料（材料自身的展示授权独立判断）
    const { rows: matRows } = await query(`
      SELECT m.id,m.slug,m.name,m.description,m.origin,m.unit,m.image_url,wm.usage_note
      FROM work_materials wm JOIN materials m ON m.id=wm.material_id
      WHERE wm.work_id=$1 ORDER BY m.name`, [w.id]);
    const mkeys = matRows.map((m) => ({ subject_type: 'material', subject_id: m.id, purpose: 'display' }));
    const mlmap = await loadLicenseMap(mkeys);
    const materials = matRows.map((m) => {
      const l = mlmap.get(licKey('material', m.id, 'display'));
      const ok = l.state === 'active';
      return {
        ...m,
        image_url: ok ? m.image_url : null,
        availability: ok ? { available: true } : { available: false, ...reasonFor(l.state), license: l },
      };
    });

    // 步骤：展示文本受作品 display 授权控制；教学文本单独判定
    const { rows: stepRows } = await query(
      `SELECT id,step_no,title,display_text,teaching_text,teaching_tip FROM work_steps WHERE work_id=$1 ORDER BY step_no`, [w.id]);
    const teaching = await canViewTeaching(w.id, contact || null);
    const steps = stepRows.map((s) => ({
      step_no: s.step_no,
      title: s.title,
      display_text: displayOk ? s.display_text : null,
      teaching: teaching.ok
        ? { unlocked: true, text: s.teaching_text, tip: s.teaching_tip }
        : { unlocked: false, reason: teaching.reason, license_state: teachingLic.state },
    }));

    // 关联课次（已发生的课程记录始终留存可见）
    const { rows: courseRows } = await query(`
      SELECT id,slug,title,location,starts_at,ends_at,capacity,status,schedule_version
      FROM courses WHERE work_id=$1 ORDER BY starts_at DESC`, [w.id]);

    // 历史发布版本
    const { rows: versions } = await query(`
      SELECT version,change_note,published_by,created_at,snapshot
      FROM published_versions WHERE entity_type='work' AND entity_id=$1 ORDER BY version DESC`, [w.id]);

    res.json({
      data: {
        id: w.id, slug: w.slug, title: w.title, subtitle: w.subtitle, published_version: w.published_version,
        story: displayOk ? w.story : null,
        cover_url: displayOk ? w.cover_url : null,
        availability: displayOk
          ? { available: true, license: displayLic }
          : { available: false, ...reasonFor(displayLic.state), license: displayLic },
        teaching_license: { state: teachingLic.state, label: teachingLic.label, expires_at: teachingLic.expires_at },
        inheritor: {
          id: w.inheritor_id, name: w.inheritor_name, title: w.inheritor_title,
          region: w.inheritor_region, bio: w.inheritor_bio, portrait_url: w.inheritor_portrait,
        },
        materials,
        steps,
        courses: courseRows,
        versions,
        enrollment: contact ? { contact, teaching_unlocked: teaching.ok, teaching_reason: teaching.ok ? null : teaching.reason } : null,
      },
    });
  } catch (e) { next(e); }
});

router.get('/materials/:slug', async (req, res, next) => {
  try {
    const { rows } = await query(`SELECT * FROM materials WHERE slug=$1`, [req.params.slug]);
    const m = rows[0];
    if (!m) return res.status(404).json({ error: 'not_found', message: '材料不存在' });
    const lmap = await loadLicenseMap([{ subject_type: 'material', subject_id: m.id, purpose: 'display' }]);
    const l = lmap.get(licKey('material', m.id, 'display'));
    res.json({ data: { ...m, image_url: l.state === 'active' ? m.image_url : null, availability: l.state === 'active' ? { available: true, license: l } : { available: false, ...reasonFor(l.state), license: l } } });
  } catch (e) { next(e); }
});

export default router;
