#!/bin/sh
# 一键：迁移 → 种子 → 启动 → 验收 → 收尾
set -e
cd "$(dirname "$0")/.."
npm run migrate
npm run seed
node server/index.js & SRV=$!
sleep 2
cleanup(){ kill $SRV 2>/dev/null || true; }
trap cleanup EXIT
node tests/acceptance.test.js
