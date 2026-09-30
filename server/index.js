import express from 'express';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config } from './config.js';
import contentRoutes from './routes/content.js';
import courseRoutes from './routes/courses.js';
import bookingRoutes, { bookingErrorHandler } from './routes/bookings.js';
import adminRoutes from './routes/admin.js';
import { sweepExpiredHolds } from './lib/seats.js';

const app = express();
app.use(express.json({ limit: '256kb' }));

app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString(), hold_seconds: config.holdSeconds }));
app.use('/api', contentRoutes);
app.use('/api/courses', courseRoutes);
app.use('/api/bookings', bookingRoutes);
app.use('/api/admin', adminRoutes);
app.use(bookingErrorHandler);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'server_error', message: err.message });
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(__dirname, '..', 'public');
app.use(express.static(pub, { extensions: ['html'] }));
// SPA-ish fallback for known pages
app.get(/^\/(story|courses|booking|me|admin|design)$/, (req, res) => res.sendFile(path.join(pub, req.path + '.html')));

const server = app.listen(config.port, () => {
  console.log(`百工拾遗 listening on http://localhost:${config.port}`);
});

// 超时回收：每 5 秒扫描；过期占位回收并按候补顺序晋升
let sweeping = false;
setInterval(async () => {
  if (sweeping) return;
  sweeping = true;
  try { await sweepExpiredHolds(); } catch (e) { console.error('sweep error', e.message); } finally { sweeping = false; }
}, 5000);

export { app, server };
