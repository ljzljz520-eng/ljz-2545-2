import 'node:process';
import { pool, query } from '../server/db.js';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const sql = fs.readFileSync(fileURLToPath(new URL('../db/schema.sql', import.meta.url)), 'utf8');
await query(sql);
console.log('✓ schema applied');
await pool.end();
