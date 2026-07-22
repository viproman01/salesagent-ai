# ---- Stage 1: сборка TypeScript ----
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build
RUN npm prune --omit=dev && npm cache clean --force

# ---- Stage 2: продакшн образ ----
FROM node:20-alpine AS runner

WORKDIR /app

# Копируем только продакшн зависимости
COPY package*.json ./
COPY --from=builder /app/node_modules ./node_modules

COPY --from=builder /app/dist ./dist
COPY docker/app/entrypoint.sh /usr/local/bin/salesagent-entrypoint

# Непривилегированный пользователь; Winston пишет production-логи в /app/logs.
RUN addgroup -S appgroup \
  && adduser -S appuser -G appgroup \
  && mkdir -p /app/logs /app/data/whatsapp-auth \
  && chown -R appuser:appgroup /app/logs /app/data \
  && chmod 0700 /app/data/whatsapp-auth \
  && chmod 0555 /usr/local/bin/salesagent-entrypoint
USER appuser

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

ENTRYPOINT ["/usr/local/bin/salesagent-entrypoint"]
CMD ["node", "dist/index.js"]
