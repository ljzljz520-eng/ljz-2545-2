'use strict';
const env = process.env;

module.exports = {
  port: parseInt(env.PORT || '4000', 10),
  holdTtlMs: parseInt(env.HOLD_TTL_MS || String(90 * 1000), 10),      // 占位短暂保留 90s
  inviteTtlMs: parseInt(env.INVITE_TTL_MS || String(10 * 60 * 1000), 10), // 候补邀请确认窗 10min
  sweepIntervalMs: parseInt(env.SWEEP_INTERVAL_MS || String(15 * 1000), 10),
  db: {
    host: env.PGHOST || '127.0.0.1',
    port: parseInt(env.PGPORT || '54330', 10),
    user: env.PGUSER || 'ich',
    password: env.PGPASSWORD || 'ich',
    database: env.PGDATABASE || 'ichcraft',
    max: 10,
  },
};
