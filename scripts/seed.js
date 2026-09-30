import 'node:process';
import { pool, query } from '../server/db.js';
import { config } from '../server/config.js';

const DAY = 86400000;
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();

const sql = {
  inheritor: `INSERT INTO inheritors (id,name,title,region,bio,portrait_url)
    VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
  work: `INSERT INTO works (id,slug,title,subtitle,summary,story,inheritor_id,cover_url,published_version)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
  asset: `INSERT INTO work_assets (work_id,kind,asset_url,note,is_current) VALUES ($1,$2,$3,$4,TRUE)`,
  material: `INSERT INTO materials (id,slug,name,description,origin,unit,image_url)
    VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
  wm: `INSERT INTO work_materials (work_id,material_id,usage_note) VALUES ($1,$2,$3)`,
  step: `INSERT INTO work_steps (work_id,step_no,title,display_text,teaching_text,teaching_tip)
    VALUES ($1,$2,$3,$4,$5,$6)`,
  lic: `INSERT INTO licenses (licensor_id,subject_type,subject_id,purpose,status,granted_at,expires_at,withdrawn_at,scope_note)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
  course: `INSERT INTO courses (id,slug,title,work_id,inheritor_id,description,location,starts_at,ends_at,capacity,status,schedule_version,original_starts_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
  pub: `INSERT INTO published_versions (entity_type,entity_id,version,snapshot,change_note,published_by)
    VALUES ($1,$2,$3,$4,$5,$6)`,
};

const q = async (s, p) => query(s, p);

await q(`TRUNCATE published_versions, booking_events, bookings, courses,
  work_steps, work_materials, materials, work_assets, works, licenses, inheritors, audit_events CASCADE`);
await q('ALTER SEQUENCE bookings_waitlist_seq_seq RESTART WITH 1');

// ---------- 传承人（虚构人物，仅作演示） ----------
const [inh] = (await q(sql.inheritor, [
  '11111111-0000-0000-0000-000000000001',
  '林守义', '闽北竹编市级代表性传承人（虚构演示人物）', '福建 · 南平政和',
  '十五岁随父学艺，至今五十余年。擅长细篾剔透与六角编，主张“竹有节，人有信”：每一件公开作品、每一段教学影像，都按用途单独授权。',
  '/assets/svg/portrait-lin.svg',
])).rows;

// ---------- 作品 ----------
const works = [
  { id:'22222222-0000-0000-0000-000000000001', slug:'yueyin-basket', title:'月隐茶篓',
    subtitle:'六角编 · 竹青收口', summary:'一只可装三两茶的细篾茶篓，篓身六角空花，收口处留竹青一圈。',
    story:'月隐茶篓的名字，是林守义为女儿出嫁那年编的陪嫁。竹要选当年立冬前的毛竹，经“剖、劈、煮、晒”四道，细篾薄如纸。六角编要求篾片“紧而不挤、松而不散”，正如日子要留三分余地。',
    cover:'/assets/svg/work-yueyin.svg' },
  { id:'22222222-0000-0000-0000-000000000002', slug:'shanlan-sieve', title:'山岚米筛',
    subtitle:'经纬密编 · 双层夹底', summary:'筛米晒谷的日常器，夹底里夹着一缕红绳，是山里人家的记号。',
    story:'米筛是山家最寻常的物什，却最见功力：筛面要能均匀透过碎米而留住整粒。林守义在夹底编入一缕红绳，说“寻常东西，也要有自己的脾气”。',
    cover:'/assets/svg/work-shanlan.svg' },
  { id:'22222222-0000-0000-0000-000000000003', slug:'tuihe-tide', title:'蜕荷茶则',
    subtitle:'随形编织 · 授权撤回演示件', summary:'本作品展示许可已被传承人撤回，页面保留其名姓与记录，素材不再公开。',
    story:'（展示许可撤回后，技艺故事正文不再公开。历史课程记录仍可查见作品名称。）',
    cover:'/assets/svg/work-tuihe.svg' },
];
for (const w of works) {
  await q(sql.work, [w.id, w.slug, w.title, w.subtitle, w.summary, w.story, inh.id, w.cover, 1]);
  await q(sql.asset, [w.id, 'cover', w.cover, '初版封面 · 传承人提供并授权展示']);
}

// ---------- 材料 ----------
const mats = [
  { id:'33333333-0000-0000-0000-000000000001', slug:'mzhu', name:'立冬毛竹',
    description:'立冬前后采伐的二年生毛竹，竹性稳、糖分低，防虫蛀。', origin:'政和锦屏竹海', unit:'根',
    image:'/assets/svg/material-bamboo.svg' },
  { id:'33333333-0000-0000-0000-000000000002', slug:'tongyou', name:'熟桐油',
    description:'反复熬过的桐油，用于收口处防潮，干后无异味。', origin:'本地油榨坊', unit:'两',
    image:'/assets/svg/material-oil.svg' },
  { id:'33333333-0000-0000-0000-000000000003', slug:'zhuhuang', name:'竹黄篾片',
    description:'去青后的竹黄层劈成的细篾，性柔，用于内层夹底。', origin:'同株取篾', unit:'束',
    image:'/assets/svg/material-strips.svg' },
  { id:'33333333-0000-0000-0000-000000000004', slug:'hongsheng', name:'红棉线',
    description:'山家记号用的染色棉线，夹入米筛双层底中。', origin:'集市染坊', unit:'缕',
    image:'/assets/svg/material-thread.svg' },
];
for (const m of mats) {
  await q(sql.material, [m.id, m.slug, m.name, m.description, m.origin, m.unit, m.image]);
}
await q(sql.wm, [works[0].id, mats[0].id, '主篾，每篓约用竹半株']);
await q(sql.wm, [works[0].id, mats[1].id, '收口刷一遍']);
await q(sql.wm, [works[0].id, mats[2].id, '内层 64 根']);
await q(sql.wm, [works[1].id, mats[0].id, '筛框与经篾']);
await q(sql.wm, [works[1].id, mats[2].id, '密编筛面']);
await q(sql.wm, [works[1].id, mats[3].id, '夹底记号一缕']);

// ---------- 步骤：展示文本 / 教学文本 分离 ----------
const stepsW1 = [
  ['选竹与伐竹','立冬后七日进山，选向阳坡二年生毛竹，竹节匀、无虫眼。','伐竹在清晨竹液未动时；切口斜 45° 朝下，避免雨水积入竹蔸。','演示：切口角度与留蔸高度。'],
  ['剖篾','竹段去节，平刀一分为二、二分为四，得粗篾。','运刀以肩带肘，刀走直线；篾厚不匀时只许修竹黄一侧，保竹青完整。','课堂练习：每人剖 8 根，厚度误差≤0.2mm。'],
  ['煮晒','粗篾入沸水焯一刻钟，捞出摊晒三日。','水中不加药；晒时篾片架空通风，每半日翻面一次。','教学影像展示合格晒架搭法。'],
  ['六角编底','以 12 根篾起底，压一挑一，交角统一 60°。','口诀“起底不正，收口不拢”：前三个交角用木制定角卡校准。','常见错误：交角漂移导致篓身歪斜。'],
  ['收口留青','口沿保留一圈竹青，刷熟桐油阴干。','桐油“三薄不如一厚”是误区；应薄刷两遍，每遍间隔一夜。','成品检验：盛水十分钟外壁无沁。'],
];
const stepsW2 = [
  ['制框','毛竹烤弯成圆框，榫口咬合。','烤弯时竹皮朝内，弯处不断洒水防焦。','演示回火定型。'],
  ['密编筛面','经篾固定后纬篾密压，不留明隙。','筛孔密度以“碎米过、整粒留”为准，约每厘米 6–7 纬。','课堂用样米现场检测。'],
  ['夹底藏绳','双层底之间平铺一缕红棉线。','红绳不可拉直绷紧，需留松量，否则筛面起鼓。','讲解“山家记号”的民俗。'],
  ['修边','外缘竹篾回折藏头，打磨无毛刺。','藏头至少压过 5 个交角，久用不散。','验收：手掌正反擦拭无勾丝。'],
];
stepsW1.forEach((s,i)=>q(sql.step,[works[0].id,i+1,...s]));
stepsW2.forEach((s,i)=>q(sql.step,[works[1].id,i+1,...s]));

// ---------- 授权（用途分离 / 撤回 / 到期场景） ----------
const past = iso(now - 30*DAY), future = iso(now + 20*DAY), expired = iso(now - 2*DAY);
// 月隐：展示长期有效；教学授权 20 天后到期（用于“授权到期”验收）
await q(sql.lic,[inh.id,'work',works[0].id,'display','active',past,null,null,'公开展示：故事、封面与展示版步骤']);
await q(sql.lic,[inh.id,'work',works[0].id,'teaching','active',past,future,null,'教学使用：教学版步骤与课堂讲义，限报名学员']);
// 山岚：展示 + 长期教学
await q(sql.lic,[inh.id,'work',works[1].id,'display','active',past,null,null,'公开展示']);
await q(sql.lic,[inh.id,'work',works[1].id,'teaching','active',past,null,null,'教学使用']);
// 蜕荷：教学授权仍在（历史课可教），展示许可已撤回（素材下架但不删记录）
await q(sql.lic,[inh.id,'work',works[2].id,'display','withdrawn',past,null,iso(now-5*DAY),'传承人撤回公开展示许可，素材停止公开']);
await q(sql.lic,[inh.id,'work',works[2].id,'teaching','active',past,expired,null,'教学授权已到期（演示到期态）']);
// 材料展示授权
await q(sql.lic,[inh.id,'material',mats[0].id,'display','active',past,null,null,'材料照片展示']);
await q(sql.lic,[inh.id,'material',mats[1].id,'display','active',past,null,null,'材料照片展示']);
await q(sql.lic,[inh.id,'material',mats[2].id,'display','active',past,null,null,'材料照片展示']);
await q(sql.lic,[inh.id,'material',mats[3].id,'display','withdrawn',past,null,iso(now-1*DAY),'红棉线素材撤回（与供应商纠纷），不影响已含它的作品文字']);

// ---------- 课次 ----------
const courses = [
  { id:'44444444-0000-0000-0000-000000000001', slug:'yueyin-s1', title:'月隐茶篓 · 周末手作课',
    work: works[0].id, desc:'一天完成茶篓起底到收口，学员带走自制成品与材料包。', loc:'百工坊 · 竹编厅',
    start: now+14*DAY, end: now+14*DAY+5*3600e3, cap: 12, status:'scheduled', ver:1, orig:null },
  { id:'44444444-0000-0000-0000-000000000002', slug:'shanlan-s1', title:'山岚米筛 · 两日工坊',
    work: works[1].id, desc:'从烤弯制框到密编夹底，完整体验日常器的做工。', loc:'百工坊 · 竹编厅',
    start: now+21*DAY, end: now+22*DAY, cap: 8, status:'scheduled', ver:1, orig:null },
  { id:'44444444-0000-0000-0000-000000000003', slug:'yueyin-race', title:'单名额竞态体验课',
    work: works[0].id, desc:'仅设 1 个名额，用于验证“两个浏览器不会各自抢到最后一个名额”。', loc:'百工坊 · 小教室',
    start: now+30*DAY, end: now+30*DAY+2*3600e3, cap: 1, status:'scheduled', ver:1, orig:null },
  { id:'44444444-0000-0000-0000-000000000004', slug:'tuihe-old', title:'蜕荷茶则 · 往期工坊',
    work: works[2].id, desc:'往期课程。作品后撤回展示许可，课程记录与名称保留。', loc:'百工坊 · 小教室',
    start: now-40*DAY, end: now-40*DAY+3*3600e3, cap: 10, status:'scheduled', ver:1, orig:null },
];
for (const c of courses) {
  await q(sql.course,[c.id,c.slug,c.title,c.work,inh.id,c.desc,c.loc,iso(c.start),iso(c.end),c.cap,c.status,c.ver,c.orig?iso(c.orig):null]);
}

// ---------- 发布版本留存 ----------
for (const w of works) {
  await q(sql.pub,['work',w.id,1,{title:w.title,cover_url:w.cover,version:1},'初版发布','林守义']);
}
for (const c of courses) {
  await q(sql.pub,['course',c.id,1,{title:c.title,starts_at:iso(c.start),capacity:c.cap,schedule_version:1},'课次发布','admin']);
}
await q(`INSERT INTO audit_events (actor,action,target,detail) VALUES ('seed','seed','site','{"note":"演示数据：人物与作品均为虚构"}')`);

console.log('✓ seeded: 1 inheritor, 3 works, 4 materials,', courses.length, 'courses; hold =', config.holdSeconds, 's');
await pool.end();
