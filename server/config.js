import process from 'node:process';
import fs from 'node:fs';

// 允许用本地 .env（不引入额外依赖）
if (fs.existsSync(new URL('../.env', import.meta.url))) {
  for (const line of fs.readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

export const config = {
  databaseUrl: process.env.DATABASE_URL || 'postgres://postgres@/heritage?host=/tmp&port=5544',
  port: Number(process.env.PORT || 3000),
  holdSeconds: Number(process.env.HOLD_SECONDS || 60),
  adminToken: process.env.ADMIN_TOKEN || 'dev-admin-token',
};
