import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import EmbeddedPG from 'embedded-postgres';
import path from 'node:path';
import fs from 'node:fs';

const PG_PORT = 55000 + Math.floor(Math.random() * 3000);
const HTTP_PORT = 42000 + Math.floor(Math.random() * 3000);
process.env.PGHOST = '127.0.0.1';
process.env.PGPORT = String(PG_PORT);
process.env.PGUSER = 'ich';
process.env.PGPASSWORD = 'ich';
process.env.PGDATABASE = 'ichcraft_test';
process.env.PORT = String(HTTP_PORT);
process.env.HOLD_TTL_MS = '8000';
process.env.INVITE_TTL_MS = '60000';
process.env.SWEEP_INTERVAL_MS = '500';
process.env.ADMIN_KEY = 'test-admin-key';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dataDir = `/tmp/ich-pgtest-data-${PG_PORT}`;
fs.rmSync(dataDir, { recursive: true, force: true });

const pg = new EmbeddedPG({
  database_dir: dataDir, port: PG_PORT, user: 'ich', password: 'ich',
  database: 'postgres', persistent: false,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(method, url, body, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (opts.idem) headers['Idempotency-Key'] = opts.idem;
  if (opts.admin) headers['X-Admin-Key'] = 'test-admin-key';
  const res = await fetch(`http://127.0.0.1:${HTTP_PORT}${url}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json, replayed: res.headers.get('Idempotency-Replayed') === 'true' };
}

let serverModule;

before(async () => {
  await pg.initialise();
  await pg.start();
  await sleep(900);
  // 创建测试库
  const { Client } = await import('pg');
  // pg 驱动会读取 PGDATABASE 环境变量覆盖 database 参数：建库时临时清除，建完恢复
  const savedPgDb = process.env.PGDATABASE;
  delete process.env.PGDATABASE;
  const admin = new Client({ host: '127.0.0.1', port: PG_PORT, user: 'ich', password: 'ich', database: 'postgres' });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${savedPgDb}`).catch(() => {});
  await admin.query(`CREATE DATABASE ${savedPgDb}`).catch(() => {});
  await admin.end();
  process.env.PGDATABASE = savedPgDb;

  // seed.js 在 import 时会自执行，测试中只用子进程 reseed()，这里不 import
  serverModule = await import(`file://${path.join(root, 'src', 'server.js')}?t=${Date.now()}`);
  await serverModule.start();
  await sleep(300);
});

after(async () => {
  try { await serverModule.stop(); } catch (e) { console.error('server stop', e.message); }
  try { await pg.stop(); } catch (e) { console.error('pg stop', e.message); }
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function reseed() {
  // seed.js 自行 run+close；重新走一次脚本会创建独立 pool —— 用子进程更稳妥
  const { execFileSync } = await import('node:child_process');
  execFileSync('node', [path.join(root, 'scripts', 'seed.js')], {
    env: { ...process.env, FORCE_SEED: '1' }, stdio: 'pipe',
  });
}

async function sessionsList() {
  const r = await api('GET', '/api/sessions');
  return r.json.sessions;
}
async function findSession(titlePart) {
  const all = await sessionsList();
  return all.find((s) => s.title.includes(titlePart));
}

// ---------------- 9. 健康检查（放在最早执行，避免与 after 钩子竞态） ----------------
test('health 与静态资源可用', async () => {
  const h = await api('GET', '/api/health');
  assert.equal(h.json.ok, true);
  const res = await fetch(`http://127.0.0.1:${HTTP_PORT}/assets/hero.svg`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/svg+xml');
});

// ---------------- 1. 重复提交（幂等） ----------------
describe('重复提交与断网重试（幂等键）', () => {
  test('同一幂等键重复请求只产生一个占位，第二次回放', async () => {
    await reseed();
    const s = await findSession('窗花');
    const body = { name: '张三', contact: 'zhangsan@example.com' };
    const r1 = await api('POST', `/api/bookings/sessions/${s.id}/holds`, body, { idem: 'k-1' });
    const r2 = await api('POST', `/api/bookings/sessions/${s.id}/holds`, body, { idem: 'k-1' });
    assert.equal(r1.status, 201);
    assert.equal(r2.status, 201);
    assert.equal(r2.replayed, true);
    assert.equal(r1.json.hold.id, r2.json.hold.id);
  });

  test('同键不同 body 被拒绝（409）', async () => {
    const s = await findSession('窗花');
    const a = await api('POST', `/api/bookings/sessions/${s.id}/holds`,
      { name: '甲', contact: 'a@x.com' }, { idem: 'k-diff' });
    assert.equal(a.status, 201);
    const b = await api('POST', `/api/bookings/sessions/${s.id}/holds`,
      { name: '乙', contact: 'DIFFERENT@x.com' }, { idem: 'k-diff' });
    assert.equal(b.status, 409);
    assert.equal(b.json.error.code, 'IDEMPOTENCY_KEY_REUSE');
  });

  test('两个浏览器用同一幂等键并发提交，也只产生一个占位', async () => {
    await reseed();
    const s = await findSession('窗花');
    const body = { name: '同键并发', contact: 'same-key-concurrent@x.com' };
    const [a, b] = await Promise.all([
      api('POST', `/api/bookings/sessions/${s.id}/holds`, body, { idem: 'same-key-race' }),
      api('POST', `/api/bookings/sessions/${s.id}/holds`, body, { idem: 'same-key-race' }),
    ]);
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    assert.equal(a.json.hold.id, b.json.hold.id);
    assert.equal(a.replayed || b.replayed, true);
  });
});

// ---------------- 2. 同时报名：最后一个名额只有一人成功 ----------------
describe('并发：两个浏览器抢最后一个名额', () => {
  test('容量 2，已有 1 人确认 → 两个并发占位请求恰好只有 1 个拿到 hold，另一个候补', async () => {
    await reseed();
    const s = await findSession('扎染'); // capacity 2
    // 先确认一人
    const h0 = await api('POST', `/api/bookings/sessions/${s.id}/holds`,
      { name: '已报名者', contact: 'first@x.com' }, { idem: 'race-0' });
    await api('POST', `/api/bookings/holds/${h0.json.hold.id}/confirm`,
      { contact: 'first@x.com' }, { idem: 'race-0c' });

    // 两个“浏览器”同时抢最后 1 个名额
    const [rA, rB] = await Promise.all([
      api('POST', `/api/bookings/sessions/${s.id}/holds`,
        { name: '浏览器A', contact: 'browser-a@x.com' }, { idem: 'race-A' }),
      api('POST', `/api/bookings/sessions/${s.id}/holds`,
        { name: '浏览器B', contact: 'browser-b@x.com' }, { idem: 'race-B' }),
    ]);
    const outcomes = [rA.json.outcome, rB.json.outcome].sort();
    assert.deepEqual(outcomes, ['held', 'waitlisted']);
    assert.notEqual(rA.json.outcome, rB.json.outcome);

    // 候补者再确认自己的“假占位”也不可能成功；剩余名额视图必须为 0
    const avail = await api('GET', `/api/sessions/${s.id}`);
    assert.equal(avail.json.remaining, 0);

    // 持占位者确认成功
    const holder = rA.json.outcome === 'held' ? rA : rB;
    const c = await api('POST', `/api/bookings/holds/${holder.json.hold.id}/confirm`,
      { contact: holder.json.body ? holder.json.body.contact : null }, { idem: 'race-Ac' });
    assert.equal(c.json.outcome, 'confirmed');

    // 同一人在第二个浏览器重复确认/重复报名 → 不产生第二条
    const again = await api('POST', `/api/bookings/sessions/${s.id}/holds`,
      { name: '已报名者', contact: 'first@x.com' }, { idem: 'race-dup' });
    assert.equal(again.json.outcome, 'already_enrolled');
  });
});

// ---------------- 3. 占位超时回收 + 候补顺序递补 ----------------
describe('超时回收与候补顺序', () => {
  test('占位未确认自动过期；等待者按先后顺序逐个递补', async () => {
    await reseed();
    const s = await findSession('扎染'); // 容量 2
    // 一人确认（永不过期），一人占位（待过期）→ 仅 1 个席位会被回收
    const h0 = await api('POST', `/api/bookings/sessions/${s.id}/holds`,
      { name: '固定学员', contact: 'hold0@x.com' }, { idem: 'exp-0' });
    const c0 = await api('POST', `/api/bookings/holds/${h0.json.hold.id}/confirm`,
      { contact: 'hold0@x.com' }, { idem: 'exp-0c' });
    assert.equal(c0.json.outcome, 'confirmed');
    const h1 = await api('POST', `/api/bookings/sessions/${s.id}/holds`,
      { name: '占位人1', contact: 'hold1@x.com' }, { idem: 'exp-1' });
    assert.equal(h1.json.outcome, 'held');
    // 两人进候补（先甲后乙）
    const w1 = await api('POST', `/api/bookings/sessions/${s.id}/holds`,
      { name: '候补甲', contact: 'wait1@x.com' }, { idem: 'exp-w1' });
    const w2 = await api('POST', `/api/bookings/sessions/${s.id}/holds`,
      { name: '候补乙', contact: 'wait2@x.com' }, { idem: 'exp-w2' });
    assert.equal(w1.json.outcome, 'waitlisted');
    assert.equal(w2.json.outcome, 'waitlisted');

    // 等待占位过期（后台 sweep 每 500ms）
    await sleep(9500);

    // 过期占位不能再确认
    const late = await api('POST', `/api/bookings/holds/${h1.json.hold.id}/confirm`,
      { contact: 'hold1@x.com' }, { idem: 'exp-late1' });
    assert.equal(late.status, 410);
    assert.equal(late.json.error.code, 'HOLD_EXPIRED');

    // 只有 1 个名额空出：候补甲（先排）被递补，候补乙继续等待
    const q1 = await api('GET', `/api/bookings/waitlist?session_id=${s.id}&contact=wait1@x.com`);
    const q2 = await api('GET', `/api/bookings/waitlist?session_id=${s.id}&contact=wait2@x.com`);
    assert.equal(q1.json.entries[0].status, 'invited');
    assert.equal(q2.json.entries[0].status, 'waiting');

    // 候补甲确认 → 报名成功；候补乙继续等待
    const conf = await api('POST', `/api/bookings/holds/${q1.json.entries[0].hold_id}/confirm`,
      { contact: 'wait1@x.com' }, { idem: 'exp-w1c' });
    assert.equal(conf.json.outcome, 'confirmed');
    const q2b = await api('GET', `/api/bookings/waitlist?session_id=${s.id}&contact=wait2@x.com`);
    assert.equal(q2b.json.entries[0].status, 'waiting');
  });

  test('主动放弃保留立即释放名额，并按候补先后递补', async () => {
    await reseed();
    const s = await findSession('扎染'); // 容量 2
    const h1 = await api('POST', `/api/bookings/sessions/${s.id}/holds`,
      { name: '临时保留者', contact: 'release-now@x.com' }, { idem: 'rel-1' });
    const h2 = await api('POST', `/api/bookings/sessions/${s.id}/holds`,
      { name: '另一位保留者', contact: 'release-keep@x.com' }, { idem: 'rel-2' });
    assert.equal(h1.json.outcome, 'held');
    assert.equal(h2.json.outcome, 'held');
    const wA = await api('POST', `/api/bookings/sessions/${s.id}/holds`,
      { name: '候补优先', contact: 'release-wa@x.com' }, { idem: 'rel-wa' });
    const wB = await api('POST', `/api/bookings/sessions/${s.id}/holds`,
      { name: '候补其次', contact: 'release-wb@x.com' }, { idem: 'rel-wb' });
    assert.equal(wA.json.outcome, 'waitlisted');
    assert.equal(wB.json.outcome, 'waitlisted');

    const release = await api('POST', `/api/bookings/holds/${h1.json.hold.id}/release`,
      { contact: 'release-now@x.com' }, { idem: 'rel-do' });
    assert.equal(release.status, 200);
    assert.equal(release.json.outcome, 'released');
    assert.equal(release.json.promoted.length, 1);
    assert.equal(release.json.promoted[0].name, '候补优先');

    const qa = await api('GET', `/api/bookings/waitlist?session_id=${s.id}&contact=release-wa@x.com`);
    const qb = await api('GET', `/api/bookings/waitlist?session_id=${s.id}&contact=release-wb@x.com`);
    assert.equal(qa.json.entries[0].status, 'invited');
    assert.equal(qb.json.entries[0].status, 'waiting');
  });

  test('取消报名立即释放名额并保留取消记录', async () => {
    await reseed();
    const s = await findSession('竹编');
    const h = await api('POST', `/api/bookings/sessions/${s.id}/holds`,
      { name: '学员', contact: 'cancel-case@x.com' }, { idem: 'can-1' });
    const c = await api('POST', `/api/bookings/holds/${h.json.hold.id}/confirm`,
      { contact: 'cancel-case@x.com' }, { idem: 'can-1c' });
    assert.equal(c.json.outcome, 'confirmed');

    const cancel = await api('POST', `/api/bookings/enrollments/${c.json.enrollment.id}/cancel`,
      { reason: 'test' }, { idem: 'can-do' });
    assert.equal(cancel.json.outcome, 'cancelled');
    // 报名记录仍在（只是 cancelled），且不会因为取消而删除。
    const mine = await api('GET', '/api/bookings/my-enrollments?contact=cancel-case@x.com');
    assert.equal(mine.json.enrollments[0].status, 'cancelled');
    assert.ok(mine.json.enrollments[0].cancelled_at);
    assert.equal(mine.json.enrollments[0].cancel_reason, 'test');
  });
});

// ---------------- 4. 管理员减容量 ----------------
describe('管理员调整容量', () => {
  test('不能低于已确认人数；挤出最新占位并转候补队首', async () => {
    await reseed();
    const s = await findSession('竹编'); // 容量 8
    // 2 人确认
    for (const [n, e] of [['一', 'cap1@x.com'], ['二', 'cap2@x.com']]) {
      const h = await api('POST', `/api/bookings/sessions/${s.id}/holds`,
        { name: n, contact: e }, { idem: 'cap-' + e });
      await api('POST', `/api/bookings/holds/${h.json.hold.id}/confirm`,
        { contact: e }, { idem: 'cap-c-' + e });
    }
    // 1 人占位
    const h3 = await api('POST', `/api/bookings/sessions/${s.id}/holds`,
      { name: '占位丙', contact: 'cap3@x.com' }, { idem: 'cap-hold3' });
    assert.equal(h3.json.outcome, 'held');

    // 减到 1 → 被拒（已有 2 确认）
    const bad = await api('PATCH', `/api/admin/sessions/${s.id}/capacity`, { capacity: 1 }, { admin: true });
    assert.equal(bad.status, 422);

    // 减到 2 → 确认2占满，占位丙被挤出
    const ok = await api('PATCH', `/api/admin/sessions/${s.id}/capacity`, { capacity: 2 }, { admin: true });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.displaced.length, 1);

    // 丙再确认自己的占位 → 410，被引导候补
    const gone = await api('POST', `/api/bookings/holds/${h3.json.hold.id}/confirm`,
      { contact: 'cap3@x.com' }, { idem: 'cap-gone' });
    assert.equal(gone.status, 410);
    assert.equal(gone.json.error.code, 'CAPACITY_REDUCED');

    // 丙已在候补（高优先级）
    const q = await api('GET', `/api/bookings/waitlist?session_id=${s.id}&contact=cap3@x.com`);
    assert.equal(q.json.entries[0].status, 'waiting');
    assert.ok(q.json.entries[0].priority >= 1);

    // 非管理员不能改
    const noauth = await api('PATCH', `/api/admin/sessions/${s.id}/capacity`, { capacity: 5 });
    assert.equal(noauth.status, 401);
  });
});

// ---------------- 5. 活动改期 ----------------
describe('活动改期', () => {
  test('改期后报名记录保留，我的报名显示 schedule_changed', async () => {
    await reseed();
    const s = await findSession('窗花');
    const h = await api('POST', `/api/bookings/sessions/${s.id}/holds`,
      { name: '改期学员', contact: 'rs@x.com' }, { idem: 'rs-1' });
    await api('POST', `/api/bookings/holds/${h.json.hold.id}/confirm`,
      { contact: 'rs@x.com' }, { idem: 'rs-1c' });

    const newStart = new Date(Date.now() + 20 * 864e5).toISOString();
    const newEnd = new Date(Date.now() + 20 * 864e5 + 3 * 36e5).toISOString();
    const r = await api('PATCH', `/api/admin/sessions/${s.id}/reschedule`,
      { start_at: newStart, end_at: newEnd }, { admin: true });
    assert.equal(r.json.schedule_version, 2);

    const mine = await api('GET', '/api/bookings/my-enrollments?contact=rs@x.com');
    assert.equal(mine.json.enrollments[0].status, 'confirmed');
    assert.equal(mine.json.enrollments[0].schedule_changed, true);
    assert.ok(mine.json.enrollments[0].note.includes('改期'));
  });
});

// ---------------- 6. 作品换图 + 发布版本 ----------------
describe('作品换图与版本', () => {
  test('换图改草稿不影响线上；重新发布后展示新图，旧版本保留', async () => {
    await reseed();
    const before = await api('GET', '/api/works/indigo-square');
    const oldUrl = before.json.cover.url;
    assert.ok(oldUrl.includes('tie-dye.svg'));

    const ov = await api('GET', '/api/admin/overview', null, { admin: true });
    const work = ov.json.works.find((w) => w.slug === 'indigo-square');

    const a = await api('POST', '/api/admin/assets',
      { url: '/assets/hero.svg', alt: '新封面' }, { admin: true });
    const swap = await api('POST', `/api/admin/works/${work.id}/swap-cover`,
      { asset_id: a.json.id }, { admin: true });
    assert.equal(swap.status, 200);

    // 未重新发布前线上仍是旧图
    const mid = await api('GET', '/api/works/indigo-square');
    assert.equal(mid.json.cover.url, oldUrl);

    // 发布新版本
    const pub = await api('POST', `/api/admin/works/${work.id}/publish`,
      { note: '更换封面' }, { admin: true });
    assert.equal(pub.json.version_no, 2);
    const after = await api('GET', '/api/works/indigo-square');
    assert.ok(after.json.cover.url.includes('hero.svg'));
  });
});

// ---------------- 7. 授权撤回 / 到期，教学与展示分离 ----------------
describe('内容授权分离与撤回', () => {
  test('撤回展示授权 → 封面下线但教学步骤仍在；课程记录保留', async () => {
    await reseed();
    // 用窗花（默认双授权），找到其 display grant 撤回
    const ov = await api('GET', '/api/admin/overview', null, { admin: true });
    const grant = ov.json.grants.find((g) =>
      g.work_title.includes('窗花') && g.scope === 'display' && g.effective);
    const rev = await api('POST', `/api/admin/grants/${grant.id}/revoke`,
      { reason: '传承人临时撤展' }, { admin: true });
    assert.equal(rev.json.scope, 'display');

    const story = await api('GET', '/api/works/six-petal-window');
    assert.equal(story.json.cover, null);
    assert.equal(story.json.steps.length, 2); // 教学授权不受影响
    assert.ok(story.json.availability_note.includes('展示授权'));

    // 该作品关联的课次仍可查询，已确认报名不受影响
    const sess = await findSession('窗花');
    assert.ok(sess);
    const h = await api('POST', `/api/bookings/sessions/${sess.id}/holds`,
      { name: '课后撤回也不影响', contact: 'post-revoke@x.com' }, { idem: 'pr-1' });
    assert.equal(h.json.outcome, 'held');
  });

  test('撤回教学授权 → 只有步骤不可见（种子数据扎染即如此）', async () => {
    const story = await api('GET', '/api/works/indigo-square');
    assert.ok(story.json.cover);          // 展示正常
    assert.equal(story.json.steps.length, 0); // 教学已撤回
    assert.ok(story.json.availability_note.includes('教学授权'));
  });

  test('授权到期后区分 expired：先撤回旧展示许可，再授予已到期许可，封面下线但步骤独立', async () => {
    await reseed();
    const ov = await api('GET', '/api/admin/overview', null, { admin: true });
    const work = ov.json.works.find((w) => w.slug === 'six-petal-window');
    for (const g of ov.json.grants.filter((g) => g.work_id === work.id && g.scope === 'display' && g.effective)) {
      await api('POST', `/api/admin/grants/${g.id}/revoke`,
        { reason: '验收：先撤回长期许可' }, { admin: true });
    }
    const expiredAt = new Date(Date.now() - 60_000).toISOString();
    const expired = await api('POST', '/api/admin/grants',
      { work_id: work.id, scope: 'display', expires_at: expiredAt }, { admin: true });
    assert.equal(expired.status, 201);

    const story = await api('GET', '/api/works/six-petal-window');
    assert.equal(story.json.cover, null);
    assert.equal(story.json.grants.display.status, 'expired');
    assert.ok(story.json.availability_note.includes('展示授权已到期'));
    assert.equal(story.json.steps.length, 2); // 教学用途不受展示许可到期影响
  });
});

// ---------------- 8. 界面原因区分（API 层错误语义） ----------------
describe('席位原因 vs 内容原因', () => {
  test('两类错误码可区分：HOLD_EXPIRED / CAPACITY_REDUCED 与授权无关', async () => {
    const s = await findSession('扎染');
    const h = await api('POST', `/api/bookings/sessions/${s.id}/holds`,
      { name: '超时人', contact: 'expire-reason@x.com' }, { idem: 'reason-1' });
    await sleep(9500);
    const late = await api('POST', `/api/bookings/holds/${h.json.hold.id}/confirm`,
      { contact: 'expire-reason@x.com' }, { idem: 'reason-1c' });
    assert.equal(late.json.error.code, 'HOLD_EXPIRED');
    assert.ok(late.json.error.message.includes('超时'));

    // 内容侧错误独立存在（作品不存在 404 是内容域）
    const nf = await api('GET', '/api/works/does-not-exist');
    assert.equal(nf.status, 404);
    assert.equal(nf.json.error.code, 'WORK_NOT_FOUND');
  });
});

// ---------------- 9. 健康检查 ----------------
