import { query, withTransaction } from '../db.js';

class AdminError extends Error {
  constructor(code, message, status = 409, extra = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.body = { error: code, message, ...extra };
  }
}

async function audit(client, actor, action, target, detail = {}) {
  await client.query(
    `INSERT INTO audit_events (actor, action, target, detail) VALUES ($1,$2,$3,$4)`,
    [actor, action, target, JSON.stringify(detail)]
  );
}

async function nextVersion(client, entityType, entityId) {
  const { rows } = await client.query(
    `SELECT COALESCE(MAX(version),0)+1 AS v FROM published_versions
     WHERE entity_type=$1 AND entity_id=$2`, [entityType, entityId]);
  return rows[0].v;
}

async function publishWork(client, workId, note, actor) {
  const { rows } = await client.query(
    `SELECT w.*, (SELECT json_agg(json_build_object('step_no',s.step_no,'title',s.title,'display_text',s.display_text))
                  FROM work_steps s WHERE s.work_id=w.id) AS steps
     FROM works w WHERE w.id=$1`, [workId]);
  const w = rows[0];
  if (!w) throw new AdminError('work_not_found', '作品不存在', 404);
  const v = await nextVersion(client, 'work', workId);
  await client.query(
    `INSERT INTO published_versions (entity_type,entity_id,version,snapshot,change_note,published_by)
     VALUES ('work',$1,$2,$3,$4,$5)`,
    [workId, v, JSON.stringify({ title: w.title, cover_url: w.cover_url, story: w.story, steps: w.steps, version: v }), note, actor]);
  await client.query(`UPDATE works SET published_version=$2, updated_at=now() WHERE id=$1`, [workId, v]);
  return v;
}

async function publishCourse(client, courseId, note, actor) {
  const { rows } = await client.query(`SELECT * FROM courses WHERE id=$1`, [courseId]);
  const c = rows[0];
  if (!c) throw new AdminError('course_not_found', '课次不存在', 404);
  const v = await nextVersion(client, 'course', courseId);
  await client.query(
    `INSERT INTO published_versions (entity_type,entity_id,version,snapshot,change_note,published_by)
     VALUES ('course',$1,$2,$3,$4,$5)`,
    [courseId, v, JSON.stringify({
      title: c.title, starts_at: c.starts_at, ends_at: c.ends_at,
      capacity: c.capacity, status: c.status, schedule_version: c.schedule_version,
    }), note, actor]);
  return v;
}

/**
 * 调整容量。减少时下限 = 已确认人数（已发生的课程记录不删除、不挤出）。
 * held 占位保持有效直到自然超时；waitlisted 不会因“减容量”被强推。
 */
export async function setCapacity({ courseId, capacity, actor = 'admin' }) {
  capacity = Number(capacity);
  if (!Number.isInteger(capacity) || capacity < 0) throw new AdminError('bad_capacity', '容量必须是非负整数', 400);
  return withTransaction(async (client) => {
    const { rows: cRows } = await client.query(`SELECT * FROM courses WHERE id=$1 FOR UPDATE`, [courseId]);
    const c = cRows[0];
    if (!c) throw new AdminError('course_not_found', '课次不存在', 404);
    // 减容量下限 = 已确认 + 仍在保留窗口内的占位（均为有效席位）。
    // 这样不会“表面超卖”；已确认记录永不删除，候补不会因减容量被强推。
    const { rows } = await client.query(`
      SELECT
        count(*) FILTER (WHERE status='confirmed')::int AS confirmed,
        count(*) FILTER (WHERE status='held' AND hold_expires_at > now())::int AS live_held
      FROM bookings WHERE course_id=$1`, [courseId]);
    const confirmed = rows[0].confirmed;
    const liveHeld = rows[0].live_held;
    const floor = confirmed + liveHeld;
    if (capacity < floor) {
      throw new AdminError('capacity_below_occupied',
        `不能把容量调到当前占用以下：已确认 ${confirmed} 人、保留中 ${liveHeld + " 个短暂保留"}，共 ${floor} 个有效席位`, 409,
        { capacity_requested: capacity, confirmed, live_held: liveHeld, floor });
    }
    await client.query(`UPDATE courses SET capacity=$2, updated_at=now() WHERE id=$1`, [courseId, capacity]);
    await audit(client, actor, 'capacity_change', courseId, { from: c.capacity, to: capacity, confirmed, live_held: liveHeld });
    await publishCourse(client, courseId, `容量由 ${c.capacity} 调整为 ${capacity}`, actor);
    // 减容后若候补之前因“满”排队、而本次恰好仍有空位（仅扩容情形），不在此处理；候补晋升统一由取消/过期路径完成
    return { courseId, capacity, previous: c.capacity, confirmed, live_held: liveHeld };
  });
}

/**
 * 活动改期：版本 +1，保留原时间；给所有活跃订单写事件与快照标记。
 * 学员侧看到“已改期”，可在新时间前免费取消。
 */
export async function rescheduleCourse({ courseId, startsAt, endsAt, actor = 'admin' }) {
  const s = new Date(startsAt), e = new Date(endsAt);
  if (isNaN(s) || isNaN(e) || e <= s) throw new AdminError('bad_time', '时间格式不正确或结束早于开始', 400);
  return withTransaction(async (client) => {
    const { rows: cRows } = await client.query(`SELECT * FROM courses WHERE id=$1 FOR UPDATE`, [courseId]);
    const c = cRows[0];
    if (!c) throw new AdminError('course_not_found', '课次不存在', 404);
    await client.query(`
      UPDATE courses SET starts_at=$2, ends_at=$3, status='rescheduled',
        schedule_version=schedule_version+1,
        original_starts_at=COALESCE(original_starts_at, starts_at), updated_at=now()
      WHERE id=$1`, [courseId, s, e]);
    const b = await client.query(`SELECT id FROM bookings WHERE course_id=$1 AND status IN ('held','confirmed','waitlisted')`, [courseId]);
    for (const r of b.rows) {
      await client.query(`INSERT INTO booking_events (booking_id,type,detail) VALUES ($1,'reschedule_notice',$2)`,
        [r.id, JSON.stringify({ old_starts_at: c.original_starts_at || c.starts_at, new_starts_at: s.toISOString(), schedule_version: c.schedule_version + 1 })]);
    }
    await audit(client, actor, 'reschedule', courseId, { from: c.starts_at, to: s.toISOString(), affected: b.rowCount });
    const v = await publishCourse(client, courseId, `改期：${new Date(c.starts_at).toLocaleString('zh-CN')} → ${s.toLocaleString('zh-CN')}`, actor);
    return { courseId, starts_at: s, ends_at: e, schedule_version: c.schedule_version + 1, published_version: v, affected: b.rowCount };
  });
}

/** 作品换图：旧图保留（replaced），不覆盖历史；课程记录引用的历史版本不受影响。触发新发布版本。 */
export async function swapWorkImage({ workId, assetUrl, note = '', actor = 'admin' }) {
  if (!assetUrl || !/^\/assets\/|^https?:\/\//.test(assetUrl)) {
    throw new AdminError('bad_asset', '素材地址不合法', 400);
  }
  return withTransaction(async (client) => {
    const { rows: wRows } = await client.query(`SELECT * FROM works WHERE id=$1 FOR UPDATE`, [workId]);
    if (!wRows[0]) throw new AdminError('work_not_found', '作品不存在', 404);
    const oldRes = await client.query(
      `UPDATE work_assets SET is_current=FALSE WHERE work_id=$1 AND kind='cover' AND is_current=TRUE
       RETURNING id, asset_url`, [workId]);
    const old = oldRes.rows;
    const insRes = await client.query(
      `INSERT INTO work_assets (work_id,kind,asset_url,note,is_current)
       VALUES ($1,'cover',$2,$3,TRUE) RETURNING id, asset_url`, [workId, assetUrl, note]);
    const ins = insRes.rows;
    if (old[0]) await client.query(`UPDATE work_assets SET replaced_by=$2 WHERE id=$1`, [old[0].id, ins[0].id]);
    await client.query(`UPDATE works SET cover_url=$2, updated_at=now() WHERE id=$1`, [workId, assetUrl]);
    await audit(client, actor, 'image_swap', workId, { old: old[0]?.asset_url || null, new: assetUrl });
    const v = await publishWork(client, workId, `更换展示图（旧图留存）：${note || assetUrl}`, actor);
    return { workId, previous_cover: old[0]?.asset_url || null, cover_url: assetUrl, published_version: v };
  });
}

/**
 * 撤回某主体某用途的授权。只影响对应素材的展示，不删除任何课程/订单记录。
 * 撤回“展示”不影响教学；反之亦然（用途分离）。
 */
export async function setLicenseStatus({ licensorId, subjectType, subjectId, purpose, status, scopeNote, expiresAt, actor = 'admin' }) {
  if (!['work', 'material'].includes(subjectType)) throw new AdminError('bad_subject', '主体类型非法', 400);
  if (!['display', 'teaching'].includes(purpose)) throw new AdminError('bad_purpose', '授权用途非法', 400);
  if (subjectType === 'material' && purpose === 'teaching') throw new AdminError('bad_purpose', '材料仅有展示授权', 400);
  if (!['active', 'withdrawn'].includes(status)) throw new AdminError('bad_status', '状态非法', 400);

  return withTransaction(async (client) => {
    const { rows } = await client.query(`
      SELECT * FROM licenses
      WHERE licensor_id=$1 AND subject_type=$2 AND subject_id=$3 AND purpose=$4
      ORDER BY granted_at DESC LIMIT 1`,
      [licensorId, subjectType, subjectId, purpose]);
    const cur = rows[0];

    // 到期场景演示：设置到期日（到期不等于撤回，也不删除）
    if (status === 'active') {
      if (cur) {
        await client.query(
          `UPDATE licenses SET status='active', expires_at=$2::timestamptz, withdrawn_at=NULL,
             scope_note=COALESCE($3::text,scope_note)
           WHERE id=$1::uuid`, [cur.id, expiresAt ? new Date(expiresAt) : null, scopeNote || null]);
        await audit(client, actor, 'license_update', `${subjectType}:${subjectId}:${purpose}`, { id: cur.id, expires_at: expiresAt || null });
        return { license_id: cur.id, status: 'active', expires_at: expiresAt || null };
      }
      const { rows: ins } = await client.query(
        `INSERT INTO licenses (licensor_id,subject_type,subject_id,purpose,status,expires_at,scope_note)
         VALUES ($1,$2,$3,$4,'active',$5,$6) RETURNING id`,
        [licensorId, subjectType, subjectId, purpose, expiresAt ? new Date(expiresAt) : null, scopeNote || '']);
      await audit(client, actor, 'license_grant', `${subjectType}:${subjectId}:${purpose}`, { id: ins[0].id });
      return { license_id: ins[0].id, status: 'active', expires_at: expiresAt || null };
    }

    // 撤回
    if (!cur) throw new AdminError('license_not_found', '没有可撤回的授权记录', 404);
    await client.query(
      `UPDATE licenses SET status='withdrawn', withdrawn_at=now(), scope_note=COALESCE($2::text,scope_note)
       WHERE id=$1::uuid`, [cur.id, scopeNote || null]);
    await audit(client, actor, 'license_withdraw', `${subjectType}:${subjectId}:${purpose}`,
      { id: cur.id, scope_note: scopeNote || cur.scope_note });
    return { license_id: cur.id, status: 'withdrawn' };
  });
}

/** 教学步骤编辑（仅教学用途，独立于展示文本，不改变展示版本授权） */
export async function updateTeachingStep({ stepId, teachingText, teachingTip, actor = 'admin' }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE work_steps SET teaching_text=COALESCE($2,teaching_text), teaching_tip=COALESCE($3,teaching_tip)
       WHERE id=$1 RETURNING id, work_id`, [stepId, teachingText ?? null, teachingTip ?? null]);
    if (!rows[0]) throw new AdminError('step_not_found', '步骤不存在', 404);
    await audit(client, actor, 'teaching_step_edit', stepId, { work_id: rows[0].work_id });
    const v = await publishWork(client, rows[0].work_id, '教学版步骤修订（不影响展示授权）', actor);
    return { step_id: stepId, published_version: v };
  });
}
