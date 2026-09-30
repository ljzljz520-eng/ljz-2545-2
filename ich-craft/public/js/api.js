/* API 封装：
   - 写操作自动生成幂等键（localStorage 留存），断网重试天然安全
   - 离线时进入发件箱排队，恢复在线后自动重放
   - GET 失败带区分原因的错误信息
*/
(function () {
  const OUTBOX_KEY = 'ich.outbox.v1';
  const ID_KEY = 'ich.idempotency.v1';
  const listeners = [];

  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  }
  function idemKey(keySeed) {
    const map = JSON.parse(localStorage.getItem(ID_KEY) || '{}');
    if (!map[keySeed]) { map[keySeed] = uuid(); localStorage.setItem(ID_KEY, JSON.stringify(map)); }
    return map[keySeed];
  }
  function getOutbox() { return JSON.parse(localStorage.getItem(OUTBOX_KEY) || '[]'); }
  function setOutbox(q) { localStorage.setItem(OUTBOX_KEY, JSON.stringify(q)); emit(); }

  function emit() { listeners.forEach((fn) => fn({ online: navigator.onLine, pending: getOutbox().length })); }
  window.addEventListener('online', () => { emit(); flush(); });
  window.addEventListener('offline', () => emit());
  window.addEventListener('storage', emit);

  async function rawRequest(method, url, body, { useIdempotency = true, keySeed = null, adminKey = null } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (useIdempotency && method !== 'GET') headers['Idempotency-Key'] = idemKey(keySeed || (method + url + JSON.stringify(body || {})));
    if (adminKey) headers['X-Admin-Key'] = adminKey;
    const res = await fetch(url, {
      method, headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch (_) {}
    if (!res.ok) {
      const err = new Error((data && data.error && data.error.message) || `请求失败（${res.status}）`);
      err.status = res.status;
      err.code = data && data.error && data.error.code;
      err.details = data && data.error && data.error.details;
      err.replayed = res.headers.get('Idempotency-Replayed') === 'true';
      throw err;
    }
    return { data, replayed: res.headers.get('Idempotency-Replayed') === 'true' };
  }

  async function get(url, opts) { return rawRequest('GET', url, null, { ...opts, useIdempotency: false }); }

  // 写操作：离线自动入队；在线先直接发，网络失败也入队
  async function mutate(method, url, body, opts = {}) {
    const envelope = {
      method, url, body: body || null,
      keySeed: opts.keySeed || (method + url + JSON.stringify(body || {})),
      adminKey: opts.adminKey || null, ts: Date.now(),
    };
    if (!navigator.onLine) {
      const q = getOutbox();
      if (!q.some((x) => x.keySeed === envelope.keySeed)) q.push(envelope);
      setOutbox(q);
      const e = new Error('当前处于断网状态，操作已保存在本机，恢复网络后将自动提交。');
      e.code = 'OFFLINE_QUEUED'; e.queued = true; throw e;
    }
    try {
      return await rawRequest(method, url, body, {
        keySeed: envelope.keySeed, adminKey: envelope.adminKey,
      });
    } catch (err) {
      if (err instanceof TypeError || /Failed to fetch|network|NetworkError/i.test(err.message)) {
        const q = getOutbox();
        if (!q.some((x) => x.keySeed === envelope.keySeed)) q.push(envelope);
        setOutbox(q);
        err.message = '网络中断，操作已暂存本机，恢复后自动提交（不会重复报名）。';
        err.code = 'OFFLINE_QUEUED'; err.queued = true;
      }
      throw err;
    }
  }

  // 恢复在线后按顺序重放
  async function flush() {
    if (!navigator.onLine) return { sent: 0 };
    const q = getOutbox();
    let sent = 0;
    const remain = [];
    for (const env of q) {
      try {
        await rawRequest(env.method, env.url, env.body, {
          keySeed: env.keySeed, adminKey: env.adminKey,
        });
        sent++;
      } catch (err) {
        // 业务性错误（如已超时）：留在队列会反复弹错，移到失败提示
        if (err.status) {
          console.warn('[outbox] rejected by server', env.url, err.code);
          window.dispatchEvent(new CustomEvent('outbox-rejected', { detail: { env, error: err } }));
        } else {
          remain.push(env);
        }
      }
    }
    setOutbox(remain);
    return { sent };
  }

  window.ICH = {
    get, mutate, flush,
    status() { return { online: navigator.onLine, pending: getOutbox().length }; },
    onStatus(fn) { listeners.push(fn); return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); }; },
    idemKey,
  };

  // 启动时若在线则尝试冲刷一次
  setTimeout(() => navigator.onLine && flush(), 600);
})();
