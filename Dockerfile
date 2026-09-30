FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
EXPOSE 3000
# 容器启动时自动迁移（schema 幂等），再启动服务
CMD ["sh","-c","node scripts/migrate.js && node server/index.js"]
