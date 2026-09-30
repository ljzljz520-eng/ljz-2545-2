FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY db ./db
COPY src ./src
COPY public ./public
COPY scripts ./scripts
EXPOSE 4000
# 启动时自动建表；首次可 SEED_ON_START=1 写入演示数据
CMD ["sh", "-c", "node -e \"const db=require('./src/db');db.initSchema().then(()=>db.close())\" && if [ \"$SEED_ON_START\" = \"1\" ]; then node scripts/seed.js; fi && node src/server.js"]
