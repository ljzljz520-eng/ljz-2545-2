'use strict';
// 种子数据：3 项非遗技艺 / 3 位传承人 / 材料 / 作品与步骤 / 授权 / 课次
const db = require('../src/db');
const content = require('../src/services/content');

const days = (n) => new Date(Date.now() + n * 864e5).toISOString();
const hours = (n) => new Date(Date.now() + n * 36e5).toISOString();

async function asset(url, alt) {
  const r = await db.query(
    'INSERT INTO assets (url, alt, mime) VALUES ($1,$2,$3) RETURNING id',
    [url, alt, 'image/svg+xml']);
  return r.rows[0].id;
}

async function run() {
  await db.initSchema();
  // 部署保护：库里已有技艺数据时不覆盖（避免容器重启清掉真实订单）；
  // 需要重建演示数据时显式 FORCE_SEED=1。
  const existed = await db.query('SELECT count(*)::int AS n FROM crafts');
  if (existed.rows[0].n > 0 && !process.env.FORCE_SEED) {
    console.log('seed skipped: database already contains data (set FORCE_SEED=1 to reseed).');
    return;
  }
  // 显式播种：清空业务数据（幂等请求记录也清，便于全新演示）
  await db.query(`TRUNCATE grant_events, enrollments, waitlist_entries, holds, sessions,
                  grants, work_versions, works, materials, craft_inheritors,
                  inheritors, crafts, assets, idempotent_requests RESTART IDENTITY CASCADE`);

  // ---------- 素材 ----------
  const coverPaper = await asset('/assets/paper-cut.svg', '剪纸团花与喜鹊');
  const coverTie = await asset('/assets/tie-dye.svg', '蓝白扎染方巾');
  const coverBamboo = await asset('/assets/bamboo.svg', '竹编茶则');
  const portrait1 = await asset('/assets/logo.svg', '传承人肖像占位');
  const pcS1 = await asset('/assets/pc-step1.svg', '起稿折剪');
  const pcS2 = await asset('/assets/pc-step2.svg', '展开成花');
  const tdS1 = await asset('/assets/td-step1.svg', '捆扎点花');
  const tdS2 = await asset('/assets/td-step2.svg', '入缸浸染');
  const bbS1 = await asset('/assets/bb-step1.svg', '选竹破篾');
  const bbS2 = await asset('/assets/bb-step2.svg', '人字纹起编');
  // 换图验收备用素材
  const coverTieV2 = await asset('/assets/hero.svg', '扎染新封面（晾晒场景）');

  // ---------- 传承人 ----------
  async function inheritor(name, title, region, bio) {
    const r = await db.query(
      `INSERT INTO inheritors (name,title,region,bio,portrait_asset_id)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [name, title, region, bio, portrait1]);
    return r.rows[0].id;
  }
  const i1 = await inheritor('周兰英', '国家级剪纸代表性传承人', '河北蔚县',
    '十二岁随母学艺，擅长窗花与团花，一把刻刀走过六十余载。');
  const i2 = await inheritor('段银海', '白族扎染省级传承人', '云南大理周城村',
    '守着祖传板蓝根染缸，坚持手工绞缬，一缸蓝色要养三年。');
  const i3 = await inheritor('罗守篾', '青神竹编市级传承人', '四川青神',
    '能把慈竹劈成薄如蝉翼的篾片，人字纹茶则是他的入门第一课。');

  // ---------- 技艺 ----------
  async function craft(slug, name, tagline, region, story, cover) {
    const r = await db.query(
      `INSERT INTO crafts (slug,name,tagline,region,story,cover_asset_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [slug, name, tagline, region, story, cover]);
    return r.rows[0].id;
  }
  const c1 = await craft('paper-cut', '蔚县剪纸', '一把刻刀，百样窗花', '河北蔚县',
    '蔚县剪纸以刻代剪，点染上色，是中国北方年节文化的纸上纹样。', coverPaper);
  const c2 = await craft('tie-dye', '大理扎染', '板蓝根养出的蓝', '云南大理',
    '白族扎染以针线绞缬、板蓝根冷染，每一件纹样都无法被复制。', coverTie);
  const c3 = await craft('bamboo-weaving', '青神竹编', '篾薄如纸，编织生活', '四川青神',
    '青神竹编将慈竹化为细丝，人字纹与提花技法编织出日用之美。', coverBamboo);

  await db.query(`INSERT INTO craft_inheritors (craft_id,inheritor_id) VALUES
    ($1,$2),($3,$4),($5,$6)`, [c1,i1,c2,i2,c3,i3]);

  // ---------- 材料 ----------
  const mats = [
    [c1, '红宣纸', '蔚县当地纸坊', '镂空后透光，年节贴窗'],
    [c1, '石蜡与宣纸垫板', '本地矿蜡', '刻制时固定多层纸张'],
    [c1, '品色点染颜料', '老号调配', '酒调品色，一色一染'],
    [c2, '纯棉白布', '周城村自织', '吸色均匀，蓝白对比柔和'],
    [c2, '板蓝根靛泥', '段家染缸', '三年老缸发酵，冷染不上色'],
    [c2, '棉线与缝针', '手工纺线', '绞缬捆扎，决定留白纹样'],
    [c3, '三年生慈竹', '岷江流域', '竹节长、篾性韧，适合细编'],
    [c3, '刮刀与匀刀', '青神铁匠铺', '将竹篾刮薄至半透明'],
  ];
  for (let i = 0; i < mats.length; i++) {
    await db.query('INSERT INTO materials (craft_id,name,origin,usage,sort) VALUES ($1,$2,$3,$4,$5)',
      [...mats[i], i]);
  }

  // ---------- 作品（草稿 + 发布版本） ----------
  async function work(craftId, inheritorId, slug, title, summary, snapshot) {
    const r = await db.query(
      `INSERT INTO works (craft_id,inheritor_id,slug,title,summary,draft_snapshot)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [craftId, inheritorId, slug, title, summary, JSON.stringify(snapshot)]);
    return r.rows[0].id;
  }

  const w1 = await work(c1, i1, 'six-petal-window', '六瓣窗花',
    '六角折剪的团花，是祖母贴在窗棂上的年。',
    { cover_asset_id: coverPaper, steps: [
      { title: '折稿起型', text: '红纸六角对折，铅笔勾出半个花瓣，刻刀垂直走刀。', image_asset_id: pcS1 },
      { title: '镂空展开', text: '先刻细处后刻外轮廓，轻展即得六瓣对称团花。', image_asset_id: pcS2 },
    ]});
  const w2 = await work(c2, i2, 'indigo-square', '蓝白方巾',
    '四段捆扎、三浸三染，冰裂纹全凭手感。',
    { cover_asset_id: coverTie, steps: [
      { title: '点花捆扎', text: '按纹样揪起布点，棉线扎紧，扎得越紧留白越净。', image_asset_id: tdS1 },
      { title: '三浸三染', text: '入老缸冷染、取出氧化，反复三次得到深浅蓝。', image_asset_id: tdS2 },
    ]});
  const w3 = await work(c3, i3, 'herringbone-tea-tray', '人字纹茶则',
    '八根篾片起底，人字形一压一挑。',
    { cover_asset_id: coverBamboo, steps: [
      { title: '选竹破篾', text: '选三年慈竹，去节刮青，匀刀劈出均匀篾片。', image_asset_id: bbS1 },
      { title: '人字起编', text: '两上两下斜编人字形，收口收沿即得茶则。', image_asset_id: bbS2 },
    ]});

  for (const id of [w1, w2, w3]) await content.publishWork(id, '首发版本');

  // ---------- 授权 ----------
  async function addGrant(workId, scope, opts = {}) {
    const r = await db.query(
      `INSERT INTO grants (work_id,scope,status,expires_at,reason,revoked_at)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [workId, scope, opts.status || 'active', opts.expires_at || null,
       opts.reason || null, opts.revoked_at || null]);
    const gId = r.rows[0].id;
    await db.query(
      `INSERT INTO grant_events (grant_id,action,reason,operator)
       VALUES ($1,$2,$3,'seed')`,
      [gId, opts.status === 'revoked' ? 'revoke' : 'grant',
       opts.reason || (scope === 'display' ? '展示授权' : '教学授权')]);
    return gId;
  }
  // 剪纸：展示+教学均有效
  await addGrant(w1, 'display');
  await addGrant(w1, 'teaching');
  // 扎染：展示有效；教学授权已撤回（验收：步骤不可见但图片可见、课程记录保留）
  await addGrant(w2, 'display');
  await addGrant(w2, 'teaching', {
    status: 'revoked', reason: '传承人暂停教学授权（工艺保密复核中）',
    revoked_at: new Date().toISOString() });
  // 扎染再加一条即将到期的展示授权（验收：授权到期）
  await addGrant(w2, 'display', { expires_at: hours(26) });
  // 竹编：展示授权将在 2 小时后到期；教学长期有效（验收：图到期但步骤仍在）
  await addGrant(w3, 'display', { expires_at: hours(2) });
  await addGrant(w3, 'teaching');

  // ---------- 课次 ----------
  async function session(o) {
    const r = await db.query(
      `INSERT INTO sessions (craft_id,work_id,title,location,start_at,end_at,capacity)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [o.craft, o.work, o.title, o.location, o.start, o.end, o.capacity]);
    return r.rows[0].id;
  }
  await session({ craft: c1, work: w1, title: '窗花入门·六瓣团花工作坊',
    location: '蔚县非遗馆 2 号教室', start: hours(30), end: hours(33), capacity: 6 });
  await session({ craft: c2, work: w2, title: '扎染方巾·冷染体验课',
    location: '周城村段家染坊', start: hours(54), end: hours(58), capacity: 2 }); // 容量2便于并发验收
  await session({ craft: c3, work: w3, title: '竹编茶则·人字纹一日课',
    location: '青神竹编合作社', start: days(5), end: days(5.2), capacity: 8 });

  console.log('seed complete: 3 crafts, 3 inheritors, 3 works(published), grants, 3 sessions');
}

run().then(() => db.close()).catch((e) => { console.error(e); process.exit(1); });
