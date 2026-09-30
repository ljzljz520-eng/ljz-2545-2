'use strict';
const express = require('express');
const path = require('path');
const config = require('./config');
const db = require('./db');
const seats = require('./services/seats');
const { ApiError } = require('./util');

const app = express();
app.use(express.json({ limit: '1mb' }));

// 简单访问日志
app.use((req, _res, next) => {
  if (req.path.startsWith('/api')) {
    console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  }
  next();
});

app.use('/api', require('./routes/public'));
app.use('/api/bookings', require('./routes/bookings'));
app.use('/api/admin', require('./routes/admin'));

app.get('/api/health', async (_req, res) => {
  await db.query('SELECT 1');
  res.json({ ok: true, time: new Date().toISOString() });
});

// 统一错误处理
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  if (err instanceof ApiError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  // 唯一约束冲突 → 可读化（主要防御并发重复报名）
  if (err.code === '23505') {
    return res.status(409).json({
      error: { code: 'ALREADY_ENROLLED',
        message: '该联系人已成功报名本课程，无需重复提交（可能另一个页面已完成）。' },
    });
  }
  console.error('[error]', err);
  res.status(500).json({ error: { code: 'INTERNAL', message: '服务器内部错误。' } });
});

app.use(express.static(path.join(__dirname, '..', 'public')));
app.get(['/craft/:slug', '/sessions', '/my', '/admin', '/story/:slug'], (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

let httpServer = null;
let sweepTimer = null;

async function start() {
  await db.initSchema();
  httpServer = await new Promise((resolve) => {
    const srv = app.listen(config.port, () => {
      console.log(`非遗手作平台 listening on http://localhost:${config.port}`);
      resolve(srv);
    });
  });

  // 后台回收器：过期占位 → 过期邀请 → 候补递补
  let sweeping = false;
  sweepTimer = setInterval(async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      const r = await seats.sweep();
      if (r.expired_holds || r.promoted.length) {
        console.log('[sweep]', JSON.stringify(r));
      }
    } catch (e) {
      console.error('[sweep] error', e.message);
    } finally { sweeping = false; }
  }, config.sweepIntervalMs);

  const shutdown = async () => {
    clearInterval(sweepTimer);
    httpServer.close(async () => { await db.close(); process.exit(0); });
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  return httpServer;
}

async function stop() {
  if (sweepTimer) clearInterval(sweepTimer);
  if (httpServer) await new Promise((r) => httpServer.close(r));
  await db.close();
}

if (require.main === module) {
  start().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { app, start, stop };
