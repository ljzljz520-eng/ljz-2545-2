'use strict';
// ============================================================
// 内容授权领域服务
//  - display（展示）与 teaching（教学）两种用途分别授权
//  - 撤回展示许可 → 线上素材下线；教学授权独立保留
//  - 历史发布版本快照不可变；已发生的课程记录永远不删除
// ============================================================
const db = require('../db');
const { ApiError } = require('../util');

async function latestGrant(client, workId, scope) {
  const r = await client.query(
    `SELECT * FROM grants
      WHERE work_id=$1 AND scope=$2
      ORDER BY created_at DESC LIMIT 1`,
    [workId, scope]
  );
  return r.rows[0] || null;
}

function grantView(grant) {
  if (!grant) return { status: 'none', expires_at: null, reason: null };
  const active = grant.status === 'active' && (!grant.expires_at || new Date(grant.expires_at) > new Date());
  if (active) return { status: 'active', expires_at: grant.expires_at, reason: null };
  if (grant.status === 'revoked') {
    return { status: 'revoked', expires_at: grant.expires_at, reason: grant.reason || '授权已撤回。' };
  }
  return { status: 'expired', expires_at: grant.expires_at, reason: '授权已到期。' };
}

async function scopeState(client, workId, scope) {
  // 语义：只要存在仍有效的新许可就继续可用；否则用“最新一条许可”区分撤回与到期。
  const active = await client.query(
    `SELECT * FROM grants
      WHERE work_id=$1 AND scope=$2 AND status='active'
        AND (expires_at IS NULL OR expires_at > now())
      ORDER BY created_at DESC LIMIT 1`,
    [workId, scope]
  );
  if (active.rows[0]) return grantView(active.rows[0]);
  return grantView(await latestGrant(client, workId, scope));
}

async function grantState(client, workId) {
  const [display, teaching] = await Promise.all([
    scopeState(client, workId, 'display'),
    scopeState(client, workId, 'teaching'),
  ]);
  return { display, teaching };
}

// 组装作品故事页（串联：传承人 + 材料 + 作品 + 教学步骤）
async function getStory(workSlug) {
  const wr = await db.query(
    `SELECT w.*, c.name AS craft_name, c.slug AS craft_slug, c.region AS craft_region,
            c.story AS craft_story, i.name AS inheritor_name, i.title AS inheritor_title,
            i.region AS inheritor_region, i.bio AS inheritor_bio
       FROM works w
       JOIN crafts c ON c.id = w.craft_id
       LEFT JOIN inheritors i ON i.id = w.inheritor_id
      WHERE w.slug=$1`, [workSlug]
  );
  const work = wr.rows[0];
  if (!work) throw new ApiError(404, 'WORK_NOT_FOUND', '作品不存在。');

  const ver = work.published_version_id
    ? (await db.query('SELECT * FROM work_versions WHERE id=$1', [work.published_version_id])).rows[0]
    : null;
  if (!ver) throw new ApiError(404, 'NOT_PUBLISHED', '该作品尚未发布任何版本。');

  const mats = (await db.query(
    'SELECT name, origin, usage FROM materials WHERE craft_id=$1 ORDER BY sort', [work.craft_id]
  )).rows;

  const states = await grantState(db, work.id);

  // ---- 展示用途 ----
  let cover = null;
  if (states.display.status === 'active') {
    const aid = ver.snapshot.cover_asset_id;
    const a = await db.query('SELECT id, url, alt FROM assets WHERE id=$1', [aid]);
    cover = a.rows[0] || null;
  }

  // ---- 教学用途（与展示授权相互独立） ----
  const steps = [];
  if (states.teaching.status === 'active') {
    for (const s of ver.snapshot.steps || []) {
      steps.push({
        title: s.title,
        text: s.text,
        image: s.image_asset_id
          ? (await db.query('SELECT id, url, alt FROM assets WHERE id=$1', [s.image_asset_id]))
              .rows[0] || null
          : null,
      });
    }
  }

  // 分别解释不可用原因（席位满员与内容授权是两回事）
  const scopeText = {
    none: '未生效', revoked: '已撤回', expired: '已到期',
  };
  const reasons = [];
  if (!cover) reasons.push(`展示授权${scopeText[states.display.status]}，作品图片暂不可见。`);
  if (!steps.length) reasons.push(`教学授权${scopeText[states.teaching.status]}，制作步骤暂不开放。`);

  return {
    work: { id: work.id, slug: work.slug, title: work.title, summary: work.summary,
            version_no: ver.version_no, published_at: ver.published_at },
    craft: { name: work.craft_name, slug: work.craft_slug, region: work.craft_region,
             story: work.craft_story },
    inheritor: work.inheritor_name ? {
      name: work.inheritor_name, title: work.inheritor_title,
      region: work.inheritor_region, bio: work.inheritor_bio,
    } : null,
    materials: mats,
    cover,
    steps,
    grants: states,
    availability_note: reasons.length ? reasons.join(' ') : null,
  };
}

// 发布当前草稿为不可变新版本
async function publishWork(workId, note) {
  return db.withTx(async (client) => {
    const wr = await client.query('SELECT * FROM works WHERE id=$1 FOR UPDATE', [workId]);
    const work = wr.rows[0];
    if (!work) throw new ApiError(404, 'WORK_NOT_FOUND', '作品不存在。');
    const max = await client.query(
      'SELECT COALESCE(max(version_no),0) AS m FROM work_versions WHERE work_id=$1', [workId]
    );
    const no = max.rows[0].m + 1;
    const vr = await client.query(
      `INSERT INTO work_versions (work_id, version_no, snapshot, note)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [workId, no, JSON.stringify(work.draft_snapshot), note || null]
    );
    await client.query(
      'UPDATE works SET published_version_id=$2, updated_at=now() WHERE id=$1',
      [workId, vr.rows[0].id]
    );
    return vr.rows[0];
  });
}

// 换图：登记新素材 + 改草稿（已发布版本仍指向旧图，直至重新发布）
async function swapCover(workId, assetId) {
  return db.withTx(async (client) => {
    const a = await client.query('SELECT * FROM assets WHERE id=$1', [assetId]);
    if (!a.rows[0]) throw new ApiError(404, 'ASSET_NOT_FOUND', '素材不存在。');
    const wr = await client.query('SELECT * FROM works WHERE id=$1 FOR UPDATE', [workId]);
    const work = wr.rows[0];
    if (!work) throw new ApiError(404, 'WORK_NOT_FOUND', '作品不存在。');
    const draft = work.draft_snapshot;
    draft.cover_asset_id = assetId;
    await client.query(
      `UPDATE works SET draft_snapshot=$2, updated_at=now() WHERE id=$1`,
      [workId, JSON.stringify(draft)]
    );
    return { work_id: workId, draft_cover_asset_id: assetId,
             note: '草稿封面已更换；重新发布后线上才会展示新图，旧发布版本保留。' };
  });
}

async function grant({ work_id, scope, expires_at }) {
  return db.withTx(async (client) => {
    const w = await client.query('SELECT 1 FROM works WHERE id=$1', [work_id]);
    if (!w.rows[0]) throw new ApiError(404, 'WORK_NOT_FOUND', '作品不存在。');
    const r = await client.query(
      `INSERT INTO grants (work_id, scope, expires_at)
       VALUES ($1,$2,$3) RETURNING *`,
      [work_id, scope, expires_at || null]
    );
    await client.query(
      `INSERT INTO grant_events (grant_id, action, reason, operator)
       VALUES ($1,'grant',$2,'admin')`,
      [r.rows[0].id, `授予${scope === 'display' ? '展示' : '教学'}授权`]
    );
    return r.rows[0];
  });
}

// 撤回授权（仅翻转授权状态；素材本体、版本、课程记录一律保留）
async function revoke(grantId, reason) {
  return db.withTx(async (client) => {
    const gr = await client.query('SELECT * FROM grants WHERE id=$1 FOR UPDATE', [grantId]);
    const g = gr.rows[0];
    if (!g) throw new ApiError(404, 'GRANT_NOT_FOUND', '授权记录不存在。');
    if (g.status === 'revoked') throw new ApiError(409, 'ALREADY_REVOKED', '该授权已撤回。');
    const r = await client.query(
      `UPDATE grants SET status='revoked', revoked_at=now(), reason=COALESCE($2, reason)
        WHERE id=$1 RETURNING *`,
      [grantId, reason || null]
    );
    await client.query(
      `INSERT INTO grant_events (grant_id, action, reason, operator)
       VALUES ($1,'revoke',$2,'admin')`,
      [grantId, reason || '管理员撤回']
    );
    return r.rows[0];
  });
}

module.exports = { getStory, publishWork, swapCover, grant, revoke, grantState };
