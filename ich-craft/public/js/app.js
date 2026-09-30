/* 守艺前端：hash 路由 + 原生渲染 */
(function () {
  const app = document.getElementById('app');
  const H = (tag, attrs = {}, children = []) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'html') el.innerHTML = v;
      else if (v !== null && v !== undefined && v !== false) el.setAttribute(k, v === true ? '' : v);
    }
    (Array.isArray(children) ? children : [children]).forEach((c) => {
      if (c == null || c === false) return;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return el;
  };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
    (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  const fmt = (iso) => iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '—';
  const dayFmt = (iso) => iso ? new Date(iso).toLocaleString('zh-CN',
    { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '—';

  function toast(msg, ms = 4200) {
    const box = document.getElementById('toasts');
    const t = H('div', { class: 'toast' }, msg);
    box.appendChild(t);
    setTimeout(() => t.remove(), ms);
  }

  function notice(kind, tag, text) {
    return H('div', { class: `notice ${kind}` }, [H('span', { class: 'tag' }, tag), H('span', {}, text)]);
  }

  const savedContact = () => {
    try { return JSON.parse(localStorage.getItem('ich.identity.v1') || '{}'); } catch { return {}; }
  };
  function identityForm() {
    const id = savedContact();
    const wrap = H('div', { class: 'form-row' });
    const ni = H('input', { placeholder: '姓名', value: id.name || '' });
    const ci = H('input', { placeholder: '手机号 / 邮箱', value: id.contact || '' });
    wrap.append(H('div', {}, [H('label', {}, '姓名'), ni]),
                H('div', {}, [H('label', {}, '联系方式（作为报名凭证）'), ci]));
    wrap._collect = () => {
      const name = ni.value.trim(), contact = ci.value.trim();
      if (name && contact) localStorage.setItem('ich.identity.v1', JSON.stringify({ name, contact }));
      return { name, contact };
    };
    return wrap;
  }

  // ---------- 离线状态横幅 ----------
  function renderOfflineBanner() {
    const banner = document.getElementById('offline-banner');
    const st = ICH.status();
    banner.innerHTML = '';
    if (!st.online) {
      banner.appendChild(notice('offline', '离线', '网络已断开：浏览缓存内容可用，报名/确认会暂存本机，恢复后自动提交且不会重复。'));
    } else if (st.pending > 0) {
      banner.appendChild(notice('info', '待提交', `有 ${st.pending} 个操作等待提交…`));
    }
  }
  ICH.onStatus(renderOfflineBanner);
  window.addEventListener('outbox-rejected', (e) => {
    const { url, error } = e.detail;
    toast(`暂存操作被服务器拒绝（${url}）：${error.message}`, 7000);
  });

  // ================= 首页 =================
  async function viewHome() {
    app.innerHTML = '';
    app.appendChild(H('div', { class: 'spinner' }));
    const { data } = await ICH.get('/api/crafts');
    app.innerHTML = '';

    app.appendChild(H('section', { class: 'hero' }, [
      H('img', { src: '/assets/hero.svg', alt: '剪纸、扎染与竹编手作插画（原创视觉）' }),
      H('div', { class: 'overlay' }, [
        H('span', { class: 'seal' }, '非 遗 手 作'),
        H('h1', {}, '一门手艺，一段人生'),
        H('p', { class: 'lead' }, '从材料、作品到传承人，走进剪纸、扎染与竹编的技艺故事；预约一次手作课，亲手接住正在远去的温度。'),
        H('p', {}, [H('a', { class: 'btn', href: '#/sessions', 'data-link': true }, '查看可报名课次')]),
      ]),
    ]));

    const sec = H('section', { class: 'section' }, [H('h2', {}, '技艺故事')]);
    const grid = H('div', { class: 'grid' });
    for (const c of data.crafts) {
      grid.appendChild(H('article', { class: 'card' }, [
        H('a', { class: 'thumb', href: `#/story/${c.slug}`, 'data-link': true },
          c.cover_url ? [H('img', { src: c.cover_url, alt: c.cover_alt || c.name })]
                      : [H('div', { style: 'display:grid;place-items:center;height:100%;color:#998b6f' }, '展示授权未生效')]),
        H('div', { class: 'body' }, [
          H('h3', {}, c.name),
          H('p', { class: 'meta' }, `📍 ${c.region || ''} · ${c.tagline || ''}`),
          H('div', { class: 'actions' },
            H('a', { class: 'btn small secondary', href: `#/story/${c.slug}`, 'data-link': true }, '读技艺故事 →')),
        ]),
      ]));
    }
    sec.appendChild(grid);
    app.appendChild(sec);

    app.appendChild(H('section', { class: 'section' }, [
      H('h2', {}, '报名席位说明'),
      H('div', { class: 'grid' }, [
        H('div', { class: 'card body' }, [H('h3', {}, '① 短暂保留'),
          H('p', { class: 'meta' }, '点击报名后，服务端把一个名额为你保留约 90 秒；此时别人看到的剩余名额会减少。')]),
        H('div', { class: 'card body' }, [H('h3', {}, '② 确认生效'),
          H('p', { class: 'meta' }, '在倒计时结束前确认，名额才真正属于你；超时未确认，名额自动回收并顺延给候补。')]),
        H('div', { class: 'card body' }, [H('h3', {}, '③ 候补递补'),
          H('p', { class: 'meta' }, '满员时进入候补队列；有人取消或占位超时，按报名先后顺序递补并给出确认时限。')]),
      ]),
      H('p', { class: 'muted', style: 'margin-top:12px' },
        '“席位不可用”（名额满/保留超时）与“内容不可用”（展示或教学授权撤回、到期）是两类完全不同的原因，页面会分别说明。'),
    ]));
  }

  // ================= 故事页 =================
  async function viewStory(slug) {
    app.innerHTML = '';
    app.appendChild(H('div', { class: 'spinner' }));
    let data;
    try {
      ({ data } = await ICH.get(`/api/works/${slug}`));
    } catch (e) {
      app.innerHTML = '';
      app.appendChild(notice('content', '无法打开', e.message));
      return;
    }
    app.innerHTML = '';

    app.appendChild(H('p', { class: 'muted' },
      [H('a', { href: '#/', 'data-link': true }, '技艺'), ' / ', data.craft.name]));
    app.appendChild(H('h1', {}, data.work.title));
    app.appendChild(H('p', { class: 'meta muted' },
      `${data.craft.region || ''} · 发布版本 v${data.work.version_no} · ${dayFmt(data.work.published_at)}`));

    // 授权状态条：分别展示两种用途
    const g = data.grants;
    const grantLine = H('div', { class: 'flow' }, [
      grantTag('展示授权', g.display), H('span', { class: 'sep' }, '｜'),
      grantTag('教学授权', g.teaching),
    ]);
    app.appendChild(grantLine);
    if (data.availability_note) app.appendChild(notice('content', '内容不可用', data.availability_note));

    const layout = H('div', { class: 'story-layout' });
    const main = H('div', {}, [
      H('div', { class: 'cover-frame' },
        data.cover
          ? H('img', { src: data.cover.url, alt: data.cover.alt || data.work.title })
          : coverBlocked()),
      H('p', { style: 'margin-top:14px' }, data.work.summary || ''),
    ]);
    const side = H('aside', { class: 'side-panel' });
    if (data.inheritor) {
      side.appendChild(H('h3', {}, `传承人 · ${data.inheritor.name}`));
      side.appendChild(H('p', { class: 'meta' },
        [H('strong', {}, data.inheritor.title || ''), H('br'), `📍 ${data.inheritor.region || ''}`]));
      side.appendChild(H('p', {}, data.inheritor.bio || ''));
    }
    side.appendChild(H('h3', {}, `所用材料（${data.materials.length}）`));
    side.appendChild(H('ul', { class: 'materials' },
      data.materials.map((m) => H('li', {}, [
        H('strong', {}, m.name),
        H('div', { class: 'muted' }, `产地：${m.origin || '—'} ｜ 用途：${m.usage || '—'}`),
      ]))));
    layout.append(main, side);
    app.appendChild(layout);

    // 教学步骤：教学授权与展示授权分离
    const stepsSec = H('section', { class: 'section' }, [H('h2', {}, '作品步骤（教学版本）')]);
    if (!data.steps.length) {
      stepsSec.appendChild(notice('content', '教学版本未授权',
        '制作步骤属于教学用途，需传承人单独授权。当前教学授权未生效、已撤回或已到期；这不影响作品展示，也不影响已报名的课程记录。'));
    } else {
      const box = H('div', { class: 'steps' });
      data.steps.forEach((s, i) => {
        box.appendChild(H('div', { class: 'step' }, [
          s.image ? H('img', { src: s.image.url, alt: s.title })
                   : H('div', { class: 'thumb', style: 'display:grid;place-items:center' }, '图未授权'),
          H('div', {}, [
            H('h3', {}, [H('span', { class: 'no' }, `第${'一二三四五六'[i] || (i + 1)}步 · `), s.title]),
            H('p', { class: 'meta' }, s.text),
          ]),
        ]));
      });
      stepsSec.appendChild(box);
    }
    app.appendChild(stepsSec);

    // 相关课次
    const sRes = await ICH.get('/api/sessions');
    const related = sRes.data.sessions.filter((x) => x.work_slug === slug);
    if (related.length) {
      const sec = H('section', { class: 'section' }, [H('h2', {}, '可参加课次')]);
      related.forEach((s) => sec.appendChild(sessionCard(s)));
      app.appendChild(sec);
    }
  }

  function grantTag(label, state) {
    const active = state.status === 'active';
    const map = {
      active: active ? `有效${state.expires_at ? `（至 ${dayFmt(state.expires_at)}）` : ''}` : '',
      none: '未授权',
      revoked: '已撤回',
      expired: '已到期',
    };
    return H('span', { class: `badge ${active ? 'confirmed' : 'cancelled'}` }, `${label}：${map[state.status]}`);
  }
  function coverBlocked() {
    return H('div', {
      style: 'aspect-ratio:3/2;display:flex;flex-direction:column;gap:8px;align-items:center;justify-content:center;color:#a93226;background:#f3e9e7;text-align:center;padding:20px',
    }, [H('strong', {}, '展示素材暂不可见'),
        H('span', { class: 'muted' }, '展示授权未生效、已撤回或已到期。撤回的是“展示许可”，素材文件、历史版本与课程记录均保留。')]);
  }

  // ================= 报名页 =================
  async function viewSessions() {
    app.innerHTML = '';
    app.appendChild(H('h1', {}, '报名课次'));
    const seatNotice = notice('seat', '席位规则', '正在读取保留时长…');
    app.appendChild(seatNotice);
    const form = identityForm();
    app.appendChild(H('div', { class: 'side-panel', style: 'margin:14px 0' }, [
      H('h3', {}, '报名信息（本机留存，便于断网重试）'), form,
    ]));
    const list = H('div', { id: 'session-list' }, H('div', { class: 'spinner' }));
    app.appendChild(list);
    await loadSessions(list, form);
  }

  async function loadSessions(container, form) {
    const { data } = await ICH.get('/api/sessions');
    const holdSeconds = Math.round((data.policy?.hold_ttl_ms || 90000) / 1000);
    seatNotice.querySelector('span:last-child').textContent =
      `报名后名额短暂保留（约 ${holdSeconds} 秒），须在倒计时内确认。满员可候补：取消、主动放弃或超时会按顺序递补，递补名额同样需要限时确认。`;
    container.innerHTML = '';
    if (!data.sessions.length) container.appendChild(H('p', { class: 'muted' }, '暂无可报名课次。'));
    data.sessions.forEach((s) => container.appendChild(sessionCard(s, {
      refresh: () => loadSessions(container, form),
    })));
  }

  // 轻量刷新：只更新右侧名额数字与说明，不重绘左侧报名流程（避免倒计时被清掉）
  async function refreshSeat(cardEl, sessionId) {
    try {
      const { data } = await ICH.get(`/api/sessions/${sessionId}`);
      const remaining = Math.max(0, data.capacity - Number(data.confirmed) - Number(data.held));
      const full = remaining <= 0;
      const pill = cardEl.querySelector('.seat-pill');
      if (pill) {
        pill.className = `seat-pill ${full ? 'full' : 'free'}`;
        pill.innerHTML = '';
        pill.appendChild(document.createTextNode(String(full ? 0 : remaining)));
        pill.appendChild(H('small', {}, full ? '已满，可候补' : '可报名额'));
      }
      const counts = cardEl.querySelector('.seat-pill + .muted');
      if (counts) counts.textContent = `已确认 ${data.confirmed} ｜ 保留中 ${data.held} ｜ 容量 ${data.capacity}`;
      const noteEl = cardEl.querySelector('.seat-note');
      if (noteEl) noteEl.textContent = full
        ? '名额已满：可候补，有人取消时按顺序递补。'
        : `剩余 ${remaining} 个可报名额（报名后为你短暂保留）。`;
    } catch { /* 离线时忽略 */ }
  }

  function sessionCard(s, ctx = {}) {
    const full = s.remaining <= 0;
    const left = H('div', {}, [
      H('div', { class: `seat-pill ${full ? 'full' : 'free'}` }, [
        String(full ? 0 : s.remaining), H('small', {}, full ? '已满，可候补' : '可报名额'),
      ]),
      H('div', { class: 'muted', style: 'text-align:center;margin-top:6px' },
        `已确认 ${s.confirmed} ｜ 保留中 ${s.held} ｜ 容量 ${s.capacity}`),
    ]);
    const card = H('div', { class: 'session', 'data-session-id': s.id }, [
      H('div', {}, [
        H('h3', {}, [s.work_title ? `${s.work_title} · ` : '', s.title]),
        H('p', { class: 'meta' },
          `🕒 ${dayFmt(s.start_at)} – ${dayFmt(s.end_at)} ｜ 📍 ${s.location || '待定'} ｜ ${s.craft_name || ''}`),
        H('p', { class: 'muted seat-note' }, s.seat_note),
        H('div', { class: 'seat-actions' }),
      ]),
      left,
    ]);
    const actions = card.querySelector('.seat-actions');
    const btn = H('button', { class: `btn ${full ? 'secondary' : ''}` }, full ? '加入候补' : '我要报名（短暂保留名额）');
    actions.appendChild(btn);
    btn.addEventListener('click', () => book(s, actions, () => refreshSeat(card, s.id)));
    return card;
  }

  async function book(s, actions, refresh) {
    // 从页面顶部表单读取（报名页）或本机留存
    const topForm = document.querySelector('.side-panel .form-row');
    let identity = { name: '', contact: '' };
    if (topForm && topForm._collect) identity = topForm._collect();
    if (!identity.name || !identity.contact) identity = savedContact();
    if (!identity.name || !identity.contact) {
      toast('请先在上方填写姓名和联系方式。'); return;
    }
    btnLock(actions, true);
    try {
      const { data } = await ICH.mutate('POST', `/api/bookings/sessions/${s.id}/holds`,
        { name: identity.name, contact: identity.contact },
        { keySeed: `hold:${s.id}:${identity.contact}` });
      if (data.outcome === 'already_enrolled') {
        actions.querySelector('button')?.remove();
        actions.appendChild(notice('success', '已报名', '你已成功报名本课，无需重复操作。'));
      } else if (data.outcome === 'waitlisted') {
        actions.querySelector('button')?.remove();
        actions.appendChild(notice('seat', '已候补', data.hint || '满员，已为你排队。'));
        startWaitlistPoll(actions, s.id, identity.contact, refresh);
      } else {
        renderHold(actions, data.hold, identity.contact, refresh);
      }
      refresh && refresh();
    } catch (e) {
      btnLock(actions, false);
      if (e.queued) actions.appendChild(notice('offline', '已暂存', e.message));
      else actions.appendChild(notice('content', '报名失败', explain(e)));
    }
  }

  function btnLock(actions, on) {
    actions.querySelectorAll('button').forEach((b) => { b.disabled = on; });
  }

  function renderHold(actions, hold, contact, refresh) {
    actions.innerHTML = '';
    const box = H('div', {}, []);
    const cd = H('strong', { style: 'color:#a93226' }, '');
    const flow = H('div', { class: 'flow' }, [
      dot(true), '提交', H('span', { class: 'sep' }, '—'),
      dot(true), `为你保留中 `, cd, H('span', { class: 'sep' }, '—'),
      dot(false), '确认报名',
    ]);
    box.appendChild(flow);
    box.appendChild(notice('seat', '名额保留中',
      '请在倒计时结束前确认；超时名额将被回收并顺延给候补。两个浏览器不会同时报上同一个名额。'));
    const confirm = H('button', { class: 'btn' }, '确认报名');
    const cancel = H('button', { class: 'btn ghost' }, '放弃保留');
    box.appendChild(H('p', { style: 'display:flex;gap:10px' }, [confirm, cancel]));
    actions.appendChild(box);

    const timer = setInterval(() => {
      const ms = new Date(hold.expires_at).getTime() - Date.now();
      if (ms <= 0) {
        clearInterval(timer);
        cd.textContent = ' 已超时';
        actions.querySelectorAll('button').forEach((b) => b.disabled = true);
        box.appendChild(notice('content', '保留超时', '名额已被系统回收；你可以重新报名或进入候补。'));
        refresh && refresh();
        return;
      }
      cd.textContent = `（剩 ${Math.ceil(ms / 1000)} 秒）`;
    }, 500);

    confirm.addEventListener('click', async () => {
      confirm.disabled = true;
      try {
        const { data, replayed } = await ICH.mutate('POST',
          `/api/bookings/holds/${hold.id}/confirm`, { contact },
          { keySeed: `confirm:${hold.id}` });
        clearInterval(timer);
        actions.innerHTML = '';
        actions.appendChild(notice('success', replayed ? '确认成功（重复请求回放）' : '报名成功',
          `名额已确认。${data.promoted && data.promoted.length ? '已有候补者收到递补通知。' : ''}`));
        actions.appendChild(H('p', {}, H('a', { class: 'btn small secondary', href: '#/my', 'data-link': true }, '查看我的报名')));
        refresh && refresh();
      } catch (e) {
        confirm.disabled = false;
        actions.appendChild(notice('content', '确认失败', explain(e)));
        if (['HOLD_EXPIRED', 'HOLD_GONE', 'CAPACITY_REDUCED'].includes(e.code)) {
          clearInterval(timer);
          const w = confirm.closest('.session');
          if (w) w.querySelectorAll('button').forEach((b) => b.disabled = true);
          // 管理员减容量/超时 → 提示转候补
          if (e.code === 'CAPACITY_REDUCED') {
            const join = H('button', { class: 'btn secondary' }, '转入候补队列');
            join.addEventListener('click', async () => {
              try {
                await ICH.mutate('POST', `/api/bookings/sessions/${hold.session_id}/holds`,
                  savedContact(), { keySeed: `hold:${hold.session_id}:${contact}:r${Date.now()}` });
                toast('已加入候补。');
                renderWaitlistState(actions, hold.session_id, contact);
              } catch (e2) { toast(explain(e2)); }
            });
            actions.appendChild(H('p', {}, join));
          }
        }
      }
    });
    cancel.addEventListener('click', async () => {
      clearInterval(timer);
      cancel.disabled = true;
      try {
        const { data } = await ICH.mutate('POST', `/api/bookings/holds/${hold.id}/release`,
          { contact }, { keySeed: `release:${hold.id}` });
        actions.innerHTML = '';
        actions.appendChild(notice(data.outcome === 'confirmed' ? 'success' : 'info',
          data.outcome === 'confirmed' ? '已确认报名'
            : data.outcome === 'expired' ? '保留已超时' : '已放弃保留',
          data.outcome === 'confirmed'
            ? '该名额此前已确认，不能放弃。'
            : data.outcome === 'expired'
              ? '名额此前已由系统超时回收，并按候补顺序顺延。'
              : '名额已立即释放，并按候补顺序顺延给下一位。'));
        refresh && refresh();
      } catch (e) {
        cancel.disabled = false;
        actions.appendChild(notice('content', '释放失败', explain(e)));
        refresh && refresh();
      }
    });
  }

  // 候补轮询：每 3 秒查询一次，一旦递补到位就渲染确认按钮；离开页面自动停止
  function startWaitlistPoll(actions, sessionId, contact, refresh) {
    const box = H('div', { class: 'waitlist-box' });
    actions.appendChild(box);
    let stopped = false;
    const tick = async () => {
      if (stopped || !document.body.contains(actions)) { stop(); return; }
      try {
        const { data } = await ICH.get(`/api/bookings/waitlist?session_id=${sessionId}&contact=${encodeURIComponent(contact)}`);
        const w = data.entries[0];
        if (w && (w.status === 'invited' || w.status === 'converted')) {
          box.innerHTML = '';
          renderWaitlistState(box, sessionId, contact);
          stop(); refresh && refresh();
          return;
        }
      } catch { /* 离线/抖动：下轮继续 */ }
      timer = setTimeout(tick, 3000);
    };
    let timer = setTimeout(tick, 2500);
    function stop() { stopped = true; clearTimeout(timer); }
  }

  async function renderWaitlistState(actions, sessionId, contact) {
    try {
      const { data } = await ICH.get(`/api/bookings/waitlist?session_id=${sessionId}&contact=${encodeURIComponent(contact)}`);
      const w = data.entries[0];
      if (!w) return;
      if (w.status === 'invited' && w.invite_expires_at && new Date(w.invite_expires_at) > new Date()) {
        const ms = new Date(w.invite_expires_at).getTime() - Date.now();
        actions.appendChild(notice('seat', '候补递补到位',
          `有名额空出，已为你保留！请在 ${Math.max(1, Math.round(ms / 1000))} 秒内确认。`));
        const btn = H('button', { class: 'btn' }, '确认递补名额');
        actions.appendChild(H('p', {}, btn));
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          try {
            await ICH.mutate('POST', `/api/bookings/holds/${w.hold_id}/confirm`,
              { contact }, { keySeed: `confirm:${w.hold_id}` });
            toast('递补确认成功！');
            actions.appendChild(H('p', {}, H('a', { class: 'btn small secondary', href: '#/my', 'data-link': true }, '查看我的报名')));
          } catch (e) { actions.appendChild(notice('content', '确认失败', explain(e))); btn.disabled = false; }
        });
      } else if (w.status === 'waiting') {
        actions.appendChild(notice('info', '候补中', '名额一空出就会按顺序递补，请留意本页提示。'));
      } else if (w.status === 'converted') {
        actions.appendChild(notice('success', '已通过候补报名', '递补名额已确认。'));
      } else {
        actions.appendChild(notice('content', '候补已失效', '递补保留超时或已取消。'));
      }
    } catch (e) { /* ignore polling errors */ }
  }

  // 把后端错误码翻译成用户能懂的“席位 vs 内容”原因
  function explain(e) {
    const map = {
      HOLD_EXPIRED: '席位原因：保留超时，名额已回收并顺延给候补，请重新报名。',
      HOLD_GONE: '席位原因：该保留名额已失效（可能管理员调整了名额）。',
      CAPACITY_REDUCED: '席位原因：管理员下调了课程容量，当前确认人数已满，可转候补。',
      CAPACITY_BELOW_ENROLLED: '席位原因：不能把容量调到低于已确认人数。',
      ALREADY_ENROLLED: '席位原因：该联系方式已报名成功（可能在另一个浏览器/标签页完成），无需重复。',
      IDEMPOTENCY_KEY_REUSE: '重复提交被拦截：同一个操作键被用于不同内容。',
      SESSION_NOT_FOUND: '课次不存在或已下架。',
      ADMIN_UNAUTHORIZED: '管理口令不正确。',
    };
    return map[e.code] || e.message;
  }

  // ================= 我的报名 =================
  async function viewMy() {
    app.innerHTML = '';
    app.appendChild(H('h1', {}, '我的报名'));
    const id = savedContact();
    const form = identityForm();
    const queryBtn = H('button', { class: 'btn' }, '查询我的报名与候补');
    app.appendChild(H('div', { class: 'side-panel', style: 'margin:14px 0' },
      [H('h3', {}, '用联系方式查询'), form, H('p', { style: 'margin-top:10px' }, queryBtn)]));
    const result = H('div', {});
    app.appendChild(result);

    async function run() {
      const v = form._collect();
      if (!v.contact) { toast('请填写联系方式'); return; }
      result.innerHTML = '';
      const [{ data: en }, { data: wl }] = await Promise.all([
        ICH.get(`/api/bookings/my-enrollments?contact=${encodeURIComponent(v.contact)}`),
        ICH.get(`/api/bookings/waitlist?contact=${encodeURIComponent(v.contact)}`),
      ]);
      if (!en.enrollments.length && !wl.entries.length) {
        result.appendChild(notice('info', '暂无记录', '还没有报名或候补记录。'));
        return;
      }
      en.enrollments.forEach((e) => {
        const card = H('div', { class: `order ${e.status}` }, [
          H('h3', {}, e.title),
          H('p', { class: 'meta' }, `报名时间：${fmt(e.created_at)} ｜ ${e.craft_name || ''}`),
          H('p', {}, [H('span', { class: `badge ${e.status}` },
            e.status === 'confirmed' ? '已确认' : '已取消（记录保留）')]),
          H('p', { class: 'meta' },
            `当前时间：${dayFmt(e.current_start_at)}（第 ${e.schedule_version} 版课表）`),
        ]);
        if (e.schedule_changed && e.status === 'confirmed') {
          card.appendChild(notice('seat', '活动已改期',
            `你报名时课表为：${dayFmt(e.booked_start_at)}；现已调整为：${dayFmt(e.current_start_at)}。报名继续有效，记录未删除。`));
        }
        if (e.note && !e.schedule_changed) card.appendChild(H('p', { class: 'muted' }, e.note));
        if (e.status === 'confirmed') {
          const cancel = H('button', { class: 'btn small danger' }, '取消报名（释放给候补）');
          cancel.addEventListener('click', async () => {
            if (!confirm('确认取消？名额将按顺序释放给候补者。')) return;
            cancel.disabled = true;
            try {
              const { data } = await ICH.mutate('POST',
                `/api/bookings/enrollments/${e.id}/cancel`, { reason: '用户主动取消' },
                { keySeed: `cancel:${e.id}` });
              toast(`已取消${data.promoted.length ? `，${data.promoted.length} 位候补者收到递补` : ''}。`);
              run();
            } catch (er) { toast(explain(er)); cancel.disabled = false; }
          });
          card.appendChild(H('p', {}, cancel));
        }
        result.appendChild(card);
      });

      wl.entries.forEach((w) => {
        if (w.status === 'converted' || w.status === 'cancelled') return;
        const c = H('div', { class: 'order' }, [
          H('h3', {}, `候补 · ${w.title}`),
          H('p', {}, [H('span', { class: `badge ${w.status === 'invited' ? 'invited' : ''}` },
            w.status === 'invited' ? '递补到位，请尽快确认' : '排队等待中')]),
        ]);
        if (w.status === 'invited') {
          c.appendChild(notice('seat', '候补递补', `请尽快回到「报名课次」页确认（保留至 ${fmt(w.invite_expires_at)}）。`));
        }
        result.appendChild(c);
      });
    }
    queryBtn.addEventListener('click', run);
    if (id.contact) run();
  }

  // ================= 管理后台 =================
  async function viewAdmin() {
    app.innerHTML = '';
    app.appendChild(H('h1', {}, '管理后台'));
    const key = localStorage.getItem('ich.adminKey') || 'dev-admin-key';
    const keyInput = H('input', { value: key, placeholder: 'X-Admin-Key' });
    const go = H('button', { class: 'btn' }, '进入');
    app.appendChild(H('div', { class: 'side-panel', style: 'margin:14px 0' }, [
      H('label', {}, '管理员口令（演示默认 dev-admin-key，生产用 ADMIN_KEY 环境变量）'),
      H('div', { class: 'form-row' }, [H('div', {}, keyInput), H('div', { style: 'flex:0;align-self:flex-end' }, go)]),
    ]));
    const body = H('div', {});
    app.appendChild(body);

    const tabs = H('div', { class: 'tabs' }, [
      tabBtn('课次与席位', 'sessions'), tabBtn('内容授权', 'grants'), tabBtn('作品发布', 'works'),
    ]);
    body.appendChild(tabs);
    const pane = H('div', {});
    body.appendChild(pane);

    let active = 'sessions';
    function tabBtn(label, id) {
      const b = H('button', { class: id === active ? 'active' : '' }, label);
      b.addEventListener('click', () => {
        active = id;
        tabs.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
        render();
      });
      return b;
    }

    async function overview() {
      const { data } = await ICH.get('/api/admin/overview', { adminKey: keyInput.value.trim() });
      return data;
    }
    async function adminMutate(method, url, payload) {
      return ICH.mutate(method, url, payload, { adminKey: keyInput.value.trim() });
    }

    async function render() {
      pane.innerHTML = '<div class="spinner"></div>';
      let ov;
      try { ov = await overview(); } catch (e) {
        pane.innerHTML = ''; pane.appendChild(notice('content', '无法进入', explain(e))); return;
      }
      localStorage.setItem('ich.adminKey', keyInput.value.trim());
      pane.innerHTML = '';
      if (active === 'sessions') renderSessions(pane, ov, render, adminMutate);
      if (active === 'grants') renderGrants(pane, ov, render, adminMutate);
      if (active === 'works') renderWorks(pane, ov, render, adminMutate);
    }
    go.addEventListener('click', render);
    if (key) render();
  }

  function renderSessions(pane, ov, refresh, adminMutate) {
    const table = H('table', {}, [
      H('thead', {}, H('tr', {}, [H('th', {}, '课次'), H('th', {}, '时间（课表版本）'),
        H('th', {}, '容量'), H('th', {}, '确认/保留/候补'), H('th', {}, '操作')])),
      H('tbody', {}, ov.sessions.map((s) => {
        const capInput = H('input', { type: 'number', min: '0', value: s.capacity, style: 'width:90px' });
        const capBtn = H('button', { class: 'btn small secondary' }, '改容量');
        const dateInput = H('input', { type: 'datetime-local', style: 'width:200px' });
        const rsBtn = H('button', { class: 'btn small ghost' }, '改期为所选时间');
        capBtn.addEventListener('click', async () => {
          try {
            const { data } = await adminMutate('PATCH', `/api/admin/sessions/${s.id}/capacity`,
              { capacity: parseInt(capInput.value, 10) });
            toast(`容量已改为 ${data.capacity}；挤出 ${data.displaced.length} 个占位（转候补队首），递补 ${data.promoted.length} 人。`);
            refresh();
          } catch (e) { toast(explain(e)); }
        });
        rsBtn.addEventListener('click', async () => {
          if (!dateInput.value) return toast('请选择新的时间');
          const start = new Date(dateInput.value).toISOString();
          const end = new Date(new Date(dateInput.value).getTime() + 3 * 36e5).toISOString();
          try {
            await adminMutate('PATCH', `/api/admin/sessions/${s.id}/reschedule`,
              { start_at: start, end_at: end });
            toast('已改期，报名记录全部保留，学员页将显示改期提示。');
            refresh();
          } catch (e) { toast(explain(e)); }
        });
        return H('tr', {}, [
          H('td', {}, s.title),
          H('td', {}, `${dayFmt(s.start_at)}（v${s.schedule_version}）`),
          H('td', {}, capInput),
          H('td', {}, `${s.confirmed} / ${s.held} / ${s.waiting}`),
          H('td', {}, H('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;align-items:center' },
            [capBtn, dateInput, rsBtn])),
        ]);
      })),
    ]);
    pane.appendChild(table);
    pane.appendChild(H('p', { class: 'muted', style: 'margin-top:10px' },
      '减容量不能低于已确认人数；被挤出的短暂占位自动释放并转入候补队首，不会删除任何已确认报名。'));
  }

  function renderGrants(pane, ov, refresh, adminMutate) {
    const table = H('table', {}, [
      H('thead', {}, H('tr', {}, [H('th', {}, '作品'), H('th', {}, '用途'), H('th', {}, '状态'),
        H('th', {}, '到期'), H('th', {}, '说明'), H('th', {}, '操作')])),
      H('tbody', {}, ov.grants.map((g) => H('tr', {}, [
        H('td', {}, g.work_title),
        H('td', {}, g.scope === 'display' ? '展示' : '教学'),
        H('td', {}, H('span', { class: `badge ${g.effective ? 'confirmed' : 'cancelled'}` },
          g.effective ? '有效' : (g.status === 'revoked' ? '已撤回' : '已到期'))),
        H('td', {}, g.expires_at ? fmt(g.expires_at) : '长期'),
        H('td', { class: 'muted' }, g.reason || ''),
        H('td', {}, g.status === 'active' ? (() => {
          const b = H('button', { class: 'btn small danger' }, '撤回授权');
          b.addEventListener('click', async () => {
            const reason = prompt('撤回原因（将记录到授权流水）：') || '管理员撤回';
            try {
              const { data } = await adminMutate('POST', `/api/admin/grants/${g.id}/revoke`, { reason });
              toast(data.note);
              refresh();
            } catch (e) { toast(explain(e)); }
          });
          return b;
        })() : '—'),
      ]))),
    ]);
    pane.appendChild(table);

    // 新增授权
    const workSel = H('select', {}, ov.works.map((w) => H('option', { value: w.id }, w.title)));
    const scopeSel = H('select', {}, [H('option', { value: 'display' }, '展示 display'),
      H('option', { value: 'teaching' }, '教学 teaching')]);
    const expInput = H('input', { type: 'datetime-local' });
    const add = H('button', { class: 'btn small' }, '授予授权');
    add.addEventListener('click', async () => {
      try {
        await adminMutate('POST', '/api/admin/grants', {
          work_id: workSel.value, scope: scopeSel.value,
          expires_at: expInput.value ? new Date(expInput.value).toISOString() : null,
        });
        toast('授权已授予。'); refresh();
      } catch (e) { toast(explain(e)); }
    });
    pane.appendChild(H('div', { class: 'side-panel', style: 'margin-top:16px' }, [
      H('h3', {}, '授予新授权'),
      H('div', { class: 'form-row' }, [
        H('div', {}, [H('label', {}, '作品'), workSel]),
        H('div', {}, [H('label', {}, '用途'), scopeSel]),
        H('div', {}, [H('label', {}, '到期时间（可空=长期）'), expInput]),
      ]),
      H('p', { style: 'margin-top:10px' }, add),
      H('p', { class: 'muted' }, '撤回展示许可仅让线上素材下线；教学授权独立。任何撤回都不删除已发生的课程记录。'),
    ]));
  }

  function renderWorks(pane, ov, refresh, adminMutate) {
    ov.works.forEach((w) => {
      const urlInput = H('input', { placeholder: '素材 URL，例如 /assets/hero.svg', style: 'width:260px' });
      const swap = H('button', { class: 'btn small secondary' }, '登记新图并换为草稿封面');
      const noteInput = H('input', { placeholder: '版本说明（可选）', style: 'width:200px' });
      const pub = H('button', { class: 'btn small' }, '发布新版本');
      const card = H('div', { class: 'order' }, [
        H('h3', {}, w.title),
        H('p', { class: 'meta' }, `slug: ${w.slug} ｜ 当前线上版本：v${w.latest_version || '未发布'}`),
        H('div', { class: 'form-row' }, [H('div', {}, [H('label', {}, '新图片 URL'), urlInput])]),
        H('p', { style: 'display:flex;gap:8px;flex-wrap:wrap;align-items:center' }, [swap]),
        H('div', { class: 'form-row' }, [H('div', {}, [H('label', {}, '版本说明'), noteInput])]),
        H('p', {}, pub),
      ]);
      swap.addEventListener('click', async () => {
        if (!urlInput.value) return toast('请填写素材 URL');
        try {
          const a = await adminMutate('POST', '/api/admin/assets', { url: urlInput.value, alt: `新封面-${w.title}` });
          const r = await adminMutate('POST', `/api/admin/works/${w.id}/swap-cover`, { asset_id: a.data.id });
          toast(r.data.note);
          refresh();
        } catch (e) { toast(explain(e)); }
      });
      pub.addEventListener('click', async () => {
        try {
          await adminMutate('POST', `/api/admin/works/${w.id}/publish`, { note: noteInput.value || null });
          toast('已发布不可变新版本，旧版本快照仍可追溯。');
          refresh();
        } catch (e) { toast(explain(e)); }
      });
      pane.appendChild(card);
    });
  }

  function dot(on) { return H('span', { class: `dot ${on ? 'on' : ''}` }); }

  // ---------- 路由 ----------
  const routes = [
    [/^#\/$/, viewHome],
    [/^#\/sessions\/?$/, viewSessions],
    [/^#\/my\/?$/, viewMy],
    [/^#\/admin\/?$/, viewAdmin],
    [/^#\/story\/([\w-]+)\/?$/, (m) => viewStory(m[1])],
  ];
  async function router() {
    document.querySelectorAll('nav a').forEach((a) =>
      a.classList.toggle('active', a.getAttribute('href') === location.hash ||
        (location.hash === '' && a.getAttribute('href') === '#/')));
    renderOfflineBanner();
    const hash = location.hash || '#/';
    for (const [re, fn] of routes) {
      const m = hash.match(re);
      if (m) { try { await fn(m); } catch (e) { app.innerHTML = ''; app.appendChild(notice('content', '页面错误', explain(e))); } return; }
    }
    app.innerHTML = '';
    app.appendChild(notice('content', '404', '页面不存在。'));
  }
  window.addEventListener('hashchange', router);
  router();
})();
