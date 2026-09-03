FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Drop dev deps for the runtime image
RUN npm prune --omit=dev

# ─── Runtime ────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app

RUN apk add --no-cache wget tini \
 && addgroup -g 1001 relavoi \
 && adduser -D -u 1001 -G relavoi relavoi

COPY --from=builder --chown=relavoi:relavoi /app/node_modules ./node_modules
COPY --from=builder --chown=relavoi:relavoi /app/dist ./dist
COPY --chown=relavoi:relavoi package.json ./

USER relavoi
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --spider --quiet http://localhost:8080/v1/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
