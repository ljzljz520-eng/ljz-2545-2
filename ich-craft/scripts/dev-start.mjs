// 本地无 Docker 时启动：拉起嵌入式真实 PostgreSQL → 建库建表 → 播种 → 启动 API
import EmbeddedPG from 'embedded-postgres';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import pgPkg from 'pg';
const { Client } = pgPkg;

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dataDir = process.env.PGDATA_DIR || path.join(root, '.pgdata');
const port = parseInt(process.env.PGPORT || '54330', 10);
const dbName = process.env.PGDATABASE || 'ichcraft';

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const pg = new EmbeddedPG({
  database_dir: dataDir,
  port,
  user: 'ich',
  password: 'ich',
  database: 'postgres',
  persistent: true,
});

// 已有数据目录时跳过 initdb（它不会自动跳过非空目录）
const alreadyInit = fs.existsSync(path.join(dataDir, 'PG_VERSION'));
if (!alreadyInit) await pg.initialise();
await pg.start();
await new Promise((r) => setTimeout(r, 700));

// 关键：pg 驱动会读取 PGDATABASE 等环境变量，先清除避免覆盖显式参数
delete process.env.PGDATABASE;
const admin = new Client({ host: '127.0.0.1', port, user: 'ich', password: 'ich', database: 'postgres' });
await admin.connect();
const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [dbName]);
if (!exists.rows.length) await admin.query(`CREATE DATABASE ${dbName}`);
await admin.end();
console.log(`[dev] embedded PostgreSQL ready on :${port}, database ${dbName}`);

const env = { ...process.env,
  PGHOST: '127.0.0.1', PGPORT: String(port), PGUSER: 'ich',
  PGPASSWORD: 'ich', PGDATABASE: dbName };

if (!process.env.SKIP_SEED) {
  await new Promise((resolve, reject) => {
    const p = spawn('node', [path.join(root, 'scripts', 'seed.js')], { stdio: 'inherit', env });
    p.on('exit', (code) => code === 0 ? resolve() : reject(new Error('seed failed: ' + code)));
  });
}

const server = spawn('node', [path.join(root, 'src', 'server.js')], { stdio: 'inherit', env });

const stop = async () => {
  server.kill('SIGTERM');
  await pg.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
