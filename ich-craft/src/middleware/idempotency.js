'use strict';
// 基于 Idempotency-Key 的服务端去重：
//  1) 同键同请求体：重复提交/断网重试回放首个完整响应；
//  2) 同键并发放到不同事务：pg_advisory_xact_lock 串行化，避免两个动作都执行；
//  3) 同键不同请求体或不同路由：拒绝复用；
//  4) 仅在业务响应可安全落库后才提交并返回，防止“动作已执行、响应丢失”。
const crypto = require('crypto');
const db = require('../db');

function bodyHash(body) {
  return crypto.createHash('sha256').update(JSON.stringify(body || {})).digest('hex');
}

function advisoryKey(idempotencyKey) {
  // bigint 空间内取哈希；碰撞只会额外串行化，不影响正确性。
  return BigInt(`0x${crypto.createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 16)}`)
    % (1n << 62n);
}

function conflict(res, code, message) {
  return res.status(409).json({ error: { code, message } });
}

module.exports = function idempotency() {
  return async function idempotencyMiddleware(req, res, next) {
    const key = req.get('idempotency-key');
    if (!key) return next();

    const route = `${req.method} ${req.originalUrl}`;
    const hash = bodyHash(req.body);
    // 锁连接来自独立连接池：避免全部连接被等待业务池的幂等请求占满后自死锁。
    const client = await db.lockPool.connect();

    let released = false;
    const releaseClient = () => {
      if (released) return;
      released = true;
      client.release();
    };
    // 请求是否由客户端断开不影响服务端业务事务；等统一错误/成功响应捕获后再归还连接。

    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [advisoryKey(key).toString()]);

      await client.query(
        `INSERT INTO idempotent_requests
           (idempotency_key, route, body_hash, status, status_code, response_body)
         VALUES ($1,$2,$3,'pending',NULL,'{}'::jsonb)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [key, route, hash]
      );

      let row = (await client.query(
        'SELECT * FROM idempotent_requests WHERE idempotency_key=$1', [key]
      )).rows[0];

      if (row.status === 'completed') {
        if (row.route !== route || row.body_hash !== hash) {
          await client.query('COMMIT');
          const conflictResponse = conflict(res, 'IDEMPOTENCY_KEY_REUSE',
            '同一幂等键被用于不同的请求内容或接口，已拒绝。');
          releaseClient();
          return conflictResponse;
        }
        await client.query(
          'UPDATE idempotent_requests SET replayed_count=replayed_count+1 WHERE idempotency_key=$1',
          [key]
        );
        await client.query('COMMIT');
        releaseClient();
        res.set('Idempotency-Replayed', 'true');
        return res.status(row.status_code).json(row.response_body);
      }

      // 崩溃恢复后接管遗留 pending；正常情况下 advisory lock 已挡住同键并发。
      if (row.route !== route || row.body_hash !== hash) {
        await client.query(
          `UPDATE idempotent_requests
             SET route=$2, body_hash=$3, status='pending', status_code=NULL,
                 response_body='{}'::jsonb, finished_at=NULL
           WHERE idempotency_key=$1`,
          [key, route, hash]
        );
      }

      const originalJson = res.json.bind(res);
      let responseCaptured = false;
      res.json = (payload) => {
        if (responseCaptured) return res;
        responseCaptured = true;
        const statusCode = res.statusCode;
        if (statusCode >= 500) {
          // 服务端故障不缓存响应：业务事务会回滚；客户端可用同一键安全重试。
          client.query('ROLLBACK').catch(() => {}).finally(() => {
            releaseClient();
            originalJson(payload);
          });
          return res;
        }
        client.query(
          `UPDATE idempotent_requests
             SET status='completed', status_code=$2, response_body=$3, finished_at=now()
           WHERE idempotency_key=$1`,
          [key, statusCode, payload]
        ).then(() => client.query('COMMIT')).then(() => {
          releaseClient();
          originalJson(payload);
        }).catch(async (persistError) => {
          console.error('[idempotency] persist failed', persistError.message);
          await client.query('ROLLBACK').catch(() => {});
          releaseClient();
          if (!res.headersSent) {
            res.status(500).json({
              error: {
                code: 'IDEMPOTENCY_PERSIST_FAILED',
                message: '处理结果无法安全持久化，请用同一个幂等键重试。',
              },
            });
          }
        });
        return res;
      };

      next();
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      releaseClient();
      next(error);
    }
  };
};
