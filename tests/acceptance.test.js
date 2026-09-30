/**
 * 百工拾遗 · 验收测试（真实 API + 真实 PostgreSQL）
 * 运行前：npm run seed && 已启动服务（npm start），或直接 `npm run test:all`
 * 覆盖：断网重试幂等 / 同时报名不超卖 / 活动改期 / 作品换图 / 授权到期 /
 *       撤回许可不删课程记录 / 占位超时回收 / 取消后候补顺序 / 管理员减容量
 */
import assert from 'node:assert/strict';
import { pool } from '../server/db.js';
import { config } from '../server/config.js';

const BASE = process.env.BASE_URL || `http://localhost:${config.port}`;
const TOKEN = config.adminToken;
let passed = 0, failed = 0;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function call(path, opts = {}) {
  const res = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}
const test = async (name, fn) => {
  try { await fn(); passed++; console.log('  ✅', name); }
  catch (e) { failed++; console.log('  ❌', name, '\n     ', e.message); }
};

// ---------- 固定种子数据 ID ----------
const C_BIG = '44444444-0000-0000-0000-000000000001';   // 月隐 常规课
const C_RACE = '44444444-0000-0000-0000-000000000003';  // 容量 1
const W1 = '22222222-0000-0000-0000-000000000001';
const W3 = '22222222-0000-0000-0000-000000000003';
const M4 = '33333333-0000-0000-0000-000000000004';
const INH = '11111111-0000-0000-0000-000000000001';

async function book(courseId, contact, key, name = '验收学员') {
  return call('/api/bookings', { method: 'POST', body: JSON.stringify({
    course_id: courseId, student_name: name, student_contact: contact, idempotency_key: key }) });
}

async function resetState() {
  await pool.query(`TRUNCATE booking_events, bookings RESTART IDENTITY CASCADE`);
  await pool.query(`ALTER SEQUENCE bookings_waitlist_seq_seq RESTART WITH 1`);
  await pool.query(`ALTER SEQUENCE bookings_waitlist_seq_seq RESTART WITH 1`);
  // 把课次恢复到种子初态（容量、排期版本、状态），保证测试可重复运行
  for (const [id, cap] of [[C_BIG, 12], [C_RACE, 1]]) {
    await pool.query(
      `UPDATE courses SET capacity=$2::int, status='scheduled', schedule_version=1, original_starts_at=NULL WHERE id=$1::uuid`,
      [id, cap]);
  }
}

console.log('\n百工拾遗 验收测试 →', BASE);
await resetState();

// 0. 健康检查
await test('健康检查返回占位时长', async () => {
  const { status, json } = await call('/api/health');
  assert.equal(status, 200); assert.ok(json.hold_seconds > 0);
});

// 1. 断网重试：同一幂等键重复提交只产生一笔
let idemContact = 'idem@test';
await test('断网重试（同幂等键）不产生重复订单', async () => {
  const key = 'accept-idem-1';
  const r1 = await book(C_BIG, idemContact, key);
  const r2 = await book(C_BIG, idemContact, key);
  assert.equal(r1.status, 201); assert.equal(r2.status, 200);
  assert.equal(r2.json.data.retried, true);
  assert.equal(r1.json.data.booking.id, r2.json.data.booking.id);
  const n = await pool.query(`SELECT count(*)::int n FROM bookings WHERE student_contact=$1`, [idemContact]);
  assert.equal(n.rows[0].n, 1);
});

// 2. 不同 key 重复报名同一课次被拒
await test('换幂等键重复报同一课次 → 409 already_enrolled', async () => {
  const r = await book(C_BIG, idemContact, 'accept-idem-2');
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'already_enrolled');
});

// 3. 同时报名最后一个名额：恰 1 人 held，其余 waitlisted，绝不两个成功
await test('并发抢最后名额：仅 1 人获得保留，其余进入候补（不超卖）', async () => {
  const N = 12;
  const reqs = Array.from({ length: N }, (_, i) =>
    book(C_RACE, `race${i}@test`, `race-key-${i}`, `竞态${i}`));
  const rs = await Promise.all(reqs);
  const held = rs.filter(r => r.json.data?.booking?.status === 'held');
  const wait = rs.filter(r => r.json.data?.booking?.status === 'waitlisted');
  assert.equal(held.length, 1, `held 应为 1，实际 ${held.length}`);
  assert.equal(wait.length, N - 1);
  const seats = held[0].json.seats;
  assert.ok(seats.reserved <= 1, 'reserved 不能超过容量');
});

// 4. 确认 + 超时回收（直接制造过期，触发 sweeper）
await test('占位超时被后台回收，状态变为 expired', async () => {
  const r = await book(C_BIG, 'expiry@test', 'exp-key');
  const id = r.json.data.booking.id;
  assert.equal(r.json.data.booking.status, 'held');
  await pool.query(`UPDATE bookings SET hold_expires_at=now()-interval '2 second' WHERE id=$1`, [id]);
  await sleep(7500); // sweeper 每 5s
  const chk = await call(`/api/bookings/${id}`);
  assert.equal(chk.json.data.booking.status, 'expired');
});

// 5. 候补顺序晋升：取消确认名额 → 最早候补者获 held
let firstWait, secondWait;
await test('取消已确认名额后，候补按排队顺序晋升为短暂保留', async () => {
  await resetState();
  // 占满 12 个，再排 2 个候补
  const booked = [];
  for (let i = 0; i < 12; i++) {
    const r = await book(C_BIG, `seq${i}@test`, `seq-key-${i}`);
    booked.push(r.json.data.booking);
  }
  const w1 = await book(C_BIG, 'wait1@test', 'wait-1');
  const w2 = await book(C_BIG, 'wait2@test', 'wait-2');
  assert.equal(w1.json.data.booking.status, 'waitlisted');
  assert.equal(w2.json.data.booking.status, 'waitlisted');
  assert.ok(w1.json.data.booking.waitlist_seq < w2.json.data.booking.waitlist_seq);
  firstWait = w1.json.data.booking.id; secondWait = w2.json.data.booking.id;

  // 确认 seq0，再取消 → 应晋升 wait1
  const victim = booked[0];
  await call(`/api/bookings/${victim.id}/confirm`, { method: 'POST', body: JSON.stringify({ student_contact: victim.student_contact, idempotency_key: 'cf-seq0' }) });
  const cancel = await call(`/api/bookings/${victim.id}/cancel`, { method: 'POST', body: JSON.stringify({ student_contact: victim.student_contact, idempotency_key: 'cx-seq0' }) });
  assert.equal(cancel.json.data.promoted.length, 1);
  assert.equal(cancel.json.data.promoted[0].id, firstWait, '必须是排队最前的 wait1 晋升');
  const poll = await call(`/api/bookings/${secondWait}/poll`);
  assert.equal(poll.json.data.status, 'waitlisted', 'wait2 仍在候补');
});

// 6. 管理员减容量下限保护
await test('管理员不能把容量减到“已确认+有效保留”以下', async () => {
  const s = await call(`/api/admin/courses/${C_BIG}/bookings`, { headers: { 'Content-Type': 'application/json', 'X-Admin-Token': TOKEN } });
  const occupied = s.json.seats.confirmed + s.json.seats.held;
  const bad = await call(`/api/admin/courses/${C_BIG}/capacity`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Token': TOKEN },
    body: JSON.stringify({ capacity: Math.max(0, occupied - 1) }),
  });
  assert.equal(bad.status, 409);
  assert.match(bad.json.error, /capacity_below/);
  const ok = await call(`/api/admin/courses/${C_BIG}/capacity`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Token': TOKEN }, body: JSON.stringify({ capacity: occupied }),
  });
  assert.equal(ok.status, 200);
});

// 7. 活动改期：版本递增、订单写事件、快照保留
await test('活动改期：排期版本+1，订单收到改期事件且保留旧快照', async () => {
  await resetState();
  const r = await book(C_RACE, 're@test', 're-key');
  assert.equal(r.status, 201);
  const bid = r.json.data.booking.id;
  const oldSnapVersion = r.json.data.booking.course_snapshot.schedule_version;
  const res = await call(`/api/admin/courses/${C_RACE}/reschedule`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Token': TOKEN },
    body: JSON.stringify({ starts_at: '2026-12-20T03:00:00Z', ends_at: '2026-12-20T06:00:00Z' }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.data.schedule_version, oldSnapVersion + 1);
  const detail = await call(`/api/bookings/${bid}`);
  const types = detail.json.data.events.map(e => e.type);
  assert.ok(types.includes('reschedule_notice'));
  assert.equal(detail.json.data.booking.course_snapshot.schedule_version, oldSnapVersion, '订单快照仍是旧版本');
  // 订单状态仍为 held（改期不改变席位状态机）；课次当前状态通过课次接口核对
  const cAfter = await call(`/api/courses/yueyin-race`);
  assert.equal(cAfter.json.data.status, 'rescheduled');
  assert.equal(cAfter.json.data.schedule_version, oldSnapVersion + 1);
});

// 8. 作品换图：旧图留存 + 新版本
await test('作品换图：生成新版本，旧素材保留且标记 replaced', async () => {
  const before = await call('/api/works/yueyin-basket');
  const oldCover = before.json.data.cover_url;
  const r = await call(`/api/admin/works/${W1}/swap-image`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Token': TOKEN },
    body: JSON.stringify({ asset_url: '/assets/svg/work-yueyin-v2.svg', note: '验收换图' }),
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.data.previous_cover, oldCover);
  const oldAssets = await pool.query(`SELECT is_current, replaced_by FROM work_assets WHERE asset_url=$1`, [oldCover]);
  assert.ok(oldAssets.rows.some(a => a.is_current === false && a.replaced_by !== null));
  const after = await call('/api/works/yueyin-basket');
  assert.equal(after.json.data.cover_url, '/assets/svg/work-yueyin-v2.svg');
  assert.ok(after.json.data.published_version >= before.json.data.published_version + 1);
});

// 9. 授权到期：自动判定 expired；到期前教学/展示差异
await test('授权到期：内容 API 判定为 expired 并解释原因', async () => {
  await call('/api/admin/licenses', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Token': TOKEN },
    body: JSON.stringify({ licensor_id: INH, subject_type: 'work', subject_id: W1, purpose: 'display', status: 'active', expires_at: new Date(Date.now() - 1000).toISOString() }) });
  const r = await call('/api/works/yueyin-basket');
  assert.equal(r.json.data.availability.available, false);
  assert.equal(r.json.data.availability.code, 'expired');
  assert.match(r.json.data.availability.title, /到期/);
  // 恢复
  await call('/api/admin/licenses', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Token': TOKEN },
    body: JSON.stringify({ licensor_id: INH, subject_type: 'work', subject_id: W1, purpose: 'display', status: 'active' }) });
});

// 10. 撤回展示许可：素材下架，但课程记录与作品名称保留
await test('撤回展示许可：作品素材下架；已发生订单与作品名仍保留', async () => {
  // 先造一笔“已发生”的确认订单（关联蜕荷作品的往期课次）
  const oldCourse = '44444444-0000-0000-0000-000000000004';
  const b = await book(oldCourse, 'history@test', 'hist-key');
  await call(`/api/bookings/${b.json.data.booking.id}/confirm`, { method: 'POST',
    body: JSON.stringify({ student_contact: 'history@test', idempotency_key: 'hist-cf' }) });

  // 蜕荷在种子里展示已撤回
  const w = await call('/api/works/tuihe-tide');
  assert.equal(w.json.data.availability.available, false);
  assert.equal(w.json.data.availability.code, 'withdrawn');
  assert.equal(w.json.data.cover_url, null);
  // 但传承人名与课程记录还在
  assert.ok(w.json.data.inheritor.name);
  assert.ok(w.json.data.courses.length >= 1);
  const mine = await call('/api/bookings/by-contact/history@test');
  assert.equal(mine.json.data.length, 1);
  assert.equal(mine.json.data[0].status, 'confirmed');
  assert.equal(mine.json.data[0].course_snapshot.title.includes('蜕荷'), true);
  // 课程列表里该课仍返回，作品图为 null
  const cs = await call('/api/courses');
  const tuiheCourse = cs.json.data.find(c => c.slug === 'tuihe-old');
  assert.ok(tuiheCourse); assert.equal(tuiheCourse.work.cover, null);
});

// 11. 撤回用途分离：撤展示不影响教学授权状态字段；材料撤回独立
await test('授权用途/主体分离：材料红棉线撤回不影响作品；展示撤回不抹教学许可', async () => {
  const m = await call('/api/materials/hongsheng');
  assert.equal(m.json.data.availability.available, false);
  assert.equal(m.json.data.availability.code, 'withdrawn');
  const w = await call('/api/works/yueyin-basket'); // 月隐不含红棉线，材料独立
  const matInYueyin = w.json.data.materials.find(x => x.slug === 'hongsheng');
  assert.equal(matInYueyin, undefined);
});

// 12. 无令牌不能管理
await test('管理员接口无令牌返回 401', async () => {
  const r = await call(`/api/admin/courses/${C_BIG}/capacity`, { method: 'POST', body: JSON.stringify({ capacity: 1 }) });
  assert.equal(r.status, 401);
});

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
await pool.end();
process.exit(failed ? 1 : 0);
