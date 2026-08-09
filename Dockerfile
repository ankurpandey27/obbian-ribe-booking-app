# ---------- Builder stage ----------
FROM node:22-alpine AS builder

WORKDIR /app

# Install deps first — layer cached until package files change
COPY package.json package-lock.json ./
RUN npm ci

# Compile TypeScript (dev deps incl. @nestjs/cli are still present)
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npm run build

# ---------- Pruned production deps stage ----------
FROM node:22-alpine AS deps

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---------- Runtime stage ----------
FROM node:22-alpine AS runtime

ENV NODE_ENV=production \
    NODE_OPTIONS="--max-old-space-size=512"

WORKDIR /app

# Non-root user for security (matches uid used by official node images)
RUN addgroup -S app && adduser -S app -G app \
    && mkdir -p /app/dist /app/logs \
    && chown -R app:app /app

# Copy compiled output + prod-only node_modules (thin image, no build tools)
COPY --from=builder /app/dist ./dist
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./

USER app

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/v1/health >/dev/null 2>&1 || exit 1

CMD ["node", "dist/main.js"]
