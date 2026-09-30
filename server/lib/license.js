import { query } from '../db.js';

/**
 * 授权状态判定（不删除任何记录，只解释“现在能不能用”）：
 *  active    未撤回且未到期
 *  withdrawn 传承人撤回了该用途许可
 *  expired   授权期限已过
 *  missing   从未取得该项授权
 * 撤回/到期均不影响已发生的课程记录；授权按 subject + purpose 分离。
 */
export function classifyLicense(lic, now = new Date()) {
  if (!lic) return { state: 'missing', label: '未取得授权' };
  if (lic.status === 'withdrawn') return { state: 'withdrawn', label: '展示许可已被传承人撤回', since: lic.withdrawn_at, note: lic.scope_note };
  if (lic.expires_at && new Date(lic.expires_at) < now) return { state: 'expired', label: '授权已到期', expires_at: lic.expires_at, note: lic.scope_note };
  return { state: 'active', label: '已授权', expires_at: lic.expires_at, note: lic.scope_note };
}

/**
 * 批量取一批主体最新一项授权记录（按许可表中行，取最近 granted_at）。
 * @param {Array<{subject_type:string, subject_id:string, purpose:string}>} keys
 */
export async function loadLicenseMap(keys, now = new Date()) {
  const out = new Map();
  if (!keys.length) return out;
  const values = [];
  const whens = [];
  keys.forEach((k, i) => {
    const b = i * 3;
    whens.push(`WHEN subject_type=$${b+1} AND subject_id=$${b+2}::uuid AND purpose=$${b+3} THEN ${i}`);
    values.push(k.subject_type, k.subject_id, k.purpose);
  });
  const { rows } = await query(`
    SELECT DISTINCT ON (subject_type, subject_id, purpose)
           subject_type, subject_id, purpose, status, expires_at, withdrawn_at, scope_note, granted_at
    FROM licenses
    WHERE (subject_type, subject_id, purpose) IN (
      ${keys.map((_,i)=>`($${i*3+1},$${i*3+2}::uuid,$${i*3+3})`).join(',')}
    )
    ORDER BY subject_type, subject_id, purpose, granted_at DESC
  `, values);
  for (const r of rows) {
    const key = `${r.subject_type}:${r.subject_id}:${r.purpose}`;
    out.set(key, classifyLicense(r, now));
  }
  for (const k of keys) {
    const key = `${k.subject_type}:${k.subject_id}:${k.purpose}`;
    if (!out.has(key)) out.set(key, classifyLicense(null, now));
  }
  return out;
}

export const licKey = (t, id, p) => `${t}:${id}:${p}`;

/** 学员是否可看某作品的教学版：教学授权有效，且有该作品相关课次的确认报名（已发生的记录不删除） */
export async function canViewTeaching(workId, contact) {
  if (!contact) return { ok: false, reason: '登录/报名后可查看教学版步骤' };
  const map = await loadLicenseMap([{ subject_type: 'work', subject_id: workId, purpose: 'teaching' }]);
  const t = map.get(licKey('work', workId, 'teaching'));
  if (t.state !== 'active') {
    return { ok: false, reason: t.state === 'withdrawn' ? '传承人已撤回教学授权' : '教学授权已到期或缺失', license: t };
  }
  const { rows } = await query(`
    SELECT b.id, c.title
    FROM bookings b JOIN courses c ON c.id = b.course_id
    WHERE c.work_id = $1 AND b.student_contact = $2
      AND b.status IN ('confirmed')
    LIMIT 1`, [workId, contact]);
  if (!rows.length) return { ok: false, reason: '报名并确认该作品的课程后可查看教学版步骤' };
  return { ok: true, license: t, enrollment: rows[0] };
}
