# syntax=docker/dockerfile:1

FROM node:20-alpine AS base
ENV NODE_ENV=production
ENV TZ=Asia/Tokyo
WORKDIR /app

# Install runtime deps first (lockfile recommended if present)
COPY package.json package-lock.json* pnpm-lock.yaml* yarn.lock* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; \
    else npm install --omit=dev; fi

# Build stage (dev deps not installed in base; acceptable for now)
FROM node:20-alpine AS builder
ENV TZ=Asia/Tokyo
WORKDIR /app
COPY . .
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi \
 && npm run build || true

# Runner image
FROM node:20-alpine AS runner
ENV NODE_ENV=production
ENV TZ=Asia/Tokyo
WORKDIR /app
COPY --from=base /app/node_modules ./node_modules
COPY package.json ./package.json
COPY dist ./dist
COPY migrations ./migrations

# Expose optional port for health checks (Socket Modeでも稼働確認用)
EXPOSE 3000

CMD ["node", "dist/index.js"]
