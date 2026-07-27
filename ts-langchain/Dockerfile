# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# 缓存依赖层
COPY package.json package-lock.json* ./
RUN npm ci --only=production

# 复制源码并编译
COPY tsconfig.json ./
COPY src/ ./src/
COPY tests/ ./tests/
RUN npx tsc

# Runtime stage
FROM node:20-alpine

WORKDIR /app

# 从 builder 复制依赖和编译产物
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./

EXPOSE 6001

CMD ["node", "dist/index.js"]
