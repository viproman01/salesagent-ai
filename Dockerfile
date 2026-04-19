# ---- Stage 1: сборка TypeScript ----
FROM node:20-alpine AS builder

WORKDIR /app

# Системные зависимости для ffmpeg (конвертация аудио)
RUN apk add --no-cache ffmpeg python3 make g++

COPY package*.json ./
RUN npm ci --only=production=false

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

# ---- Stage 2: продакшн образ ----
FROM node:20-alpine AS runner

WORKDIR /app

RUN apk add --no-cache ffmpeg

# Копируем только продакшн зависимости
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

COPY --from=builder /app/dist ./dist

# Непривилегированный пользователь
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "dist/index.js"]
