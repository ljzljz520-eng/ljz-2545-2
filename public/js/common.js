// 百工拾遗 · 前端公共能力：API、幂等键、断网重试、倒计时、Toast、状态文案
export const HOLD_LABEL = {
  held: { txt: '短暂保留中', cls: 'gold' },
  confirmed: { txt: '已确认', cls: 'green' },
  waitlisted: { txt: '候补中', cls: 'blue' },
  cancelled: { txt: '已取消', cls: 'gray' },
  expired: { txt: '占位已过期', cls: 'red' },
};

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function fmtTime(t) {
  if (!t) return '—';
  const d = new Date(t);
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}
export function fmtFull(t) {
  if (!t) return '—';
  return new Date(t).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

/** 幂等键：同一“意图”重试不变；localStorage 持久，断网/刷新后仍可重放 */
export function idemKey(namespace, seed = {}) {
  const raw = `${namespace}:${Object.entries(seed).map(([k, v]) => `${k}=${v}`).sort().join('&')}`;
  let h = 5381;
  for (let i = 0; i < raw.length; i++) h = ((h << 5) + h + raw.charCodeAt(i)) >>> 0;
  return `${namespace}_${h.toString(36)}_${Date.now().toString(36).slice(-4)}`;
}
export function saveIdem(action, key) {
  try { localStorage.setItem(`idem:${action}`, key); } catch {}
  return key;
}
export function getIdem(action) {
  try { return localStorage.getItem(`idem:${action}`); } catch { return null; }
}

export async function api(path, options = {}) {
  const opts = { headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options };
  if (options.body && typeof options.body !== 'string') opts.body = JSON.stringify(options.body);
  let res;
  try {
    res = await fetch(path, opts);
  } catch (networkErr) {
    const e = new Error('网络不可用：请求已保留，恢复联网后可重试');
    e.network = true; throw e;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data.message || `请求失败（${res.status}）`);
    e.status = res.status; e.body = data; throw e;
  }
  return data;
}

/** 带断网重试的提交：失败时提供“保留后重试”，由调用方传入固定幂等键 */
export async function submitWithRetry(path, body, { retries = 0 } = {}) {
  try {
    return await api(path, { method: 'POST', body });
  } catch (e) {
    if (e.network && retries < 6) {
      toast(`网络断开，已保留报名信息，${retries + 1} 秒后自动重试…`, 'err');
      await new Promise((r) => setTimeout(r, 1000 * (retries + 1)));
      return submitWithRetry(path, body, { retries: retries + 1 });
    }
    throw e;
  }
}

export function toast(msg, kind = '') {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.className = `toast show ${kind}`;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.className = 'toast'; }, 3600);
}

/** 倒计时：服务端 hold_expires_at 为准；到点回调（通常触发轮询） */
export function countdown(expiresAt, onTick, onEnd) {
  const end = new Date(expiresAt).getTime();
  function tick() {
    const remain = Math.max(0, Math.round((end - Date.now()) / 1000));
    onTick(remain);
    if (remain <= 0) { clearInterval(timer); onEnd && onEnd(); }
  }
  tick();
  const timer = setInterval(tick, 1000);
  return () => clearInterval(timer);
}

/** 统一解释“席位 vs 内容”不可用 */
export function availabilityNotice(a, kind = 'content') {
  if (!a || a.available) return '';
  const isSeat = kind === 'seat';
  const icon = isSeat ? '🎟️' : a.code === 'withdrawn' ? '🚫' : a.code === 'expired' ? '⏳' : '🔒';
  return `<div class="notice ${isSeat ? 'seat' : 'content'}">
    <span class="ic">${icon}</span>
    <div><strong>${esc(a.title || '暂不可用')}</strong>
      <div class="sub">${esc(a.detail || '')}${a.license?.expires_at ? `（到期：${fmtFull(a.license.expires_at)}）` : ''}</div>
    </div></div>`;
}

export function seatStateText(s) {
  if (s.status === 'canceled') return { title: '课次已取消', detail: '该课次已被取消，报名入口关闭；历史订单仍可在“我的报名”查看。' };
  if (s.free <= 0 && s.waitlisted >= 0) return { title: '名额已满', detail: `当前可报名额为 0，你可加入候补；若有确认名额取消或占位超时，将按候补顺序递补并短暂保留。` };
  return null;
}

export function badgeFor(status) {
  const m = HOLD_LABEL[status] || { txt: status, cls: 'gray' };
  return `<span class="badge ${m.cls}">${m.txt}</span>`;
}

export function setActiveNav() {
  const path = location.pathname.replace(/\.html$/, '');
  document.querySelectorAll('.nav nav a').forEach((a) => {
    const href = a.getAttribute('href');
    if (href === path || (path.startsWith(href) && href !== '/')) a.classList.add('active');
  });
}

export function bindOfflineBanner() {
  const bar = document.createElement('div');
  bar.className = 'offline-banner';
  bar.textContent = '当前处于断网状态：操作会在本地保留，恢复网络后自动重试。';
  document.body.prepend(bar);
  const upd = () => bar.classList.toggle('show', !navigator.onLine);
  window.addEventListener('online', () => { upd(); toast('网络已恢复，正在同步…', 'ok'); });
  window.addEventListener('offline', () => { upd(); toast('已断网：报名信息会保留，不会重复提交', 'err'); });
  upd();
}

export function getContact() {
  try { return localStorage.getItem('contact') || ''; } catch { return ''; }
}
export function setContact(v) { try { localStorage.setItem('contact', v); } catch {} }
export function getName() { try { return localStorage.getItem('name') || ''; } catch { return ''; }
}
export function setName(v) { try { localStorage.setItem('name', v); } catch {} }
