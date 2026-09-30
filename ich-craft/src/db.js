'use strict';
const { Pool } = require('pg');
const config = require('./config');
const fs = require('fs');
const path = require('path');

const pool = new Pool(config.db);
// 幂等中间件需要持锁等待业务事务完成；若与业务池共用，占满连接时可能自死锁。
const lockPool = new Pool(config.db);

pool.on('error', (err) => {
  console.error('[pg] idle client error', err);
});
lockPool.on('error', (err) => {
  console.error('[pg] idle lock client error', err);
});

async function query(text, params) {
  return pool.query(text, params);
}

async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}

async function initSchema() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  await pool.query(sql);
}

async function close() {
  await pool.end();
  await lockPool.end();
}

module.exports = { pool, lockPool, query, withTx, initSchema, close };
