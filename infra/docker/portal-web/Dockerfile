# =============================================================================
# Forge — Portal Frontend Image
# Base: node:20-alpine
#
# Build:  docker build --build-arg API_URL=http://api:8080 -t forge/portal-web .
# Run:    docker run -p 3001:3001 forge/portal-web
# =============================================================================

FROM node:20-alpine AS deps

WORKDIR /app

# Install dependencies only (layer cached unless package.json changes)
COPY package.json package-lock.json* ./
RUN npm ci --frozen-lockfile

# ── Builder ──────────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

ARG API_URL=http://portal-api:8080
ARG AZURE_CLIENT_ID=""
ARG AZURE_TENANT_ID=""
ARG WEB_URL=http://localhost:3001

ENV NEXT_TELEMETRY_DISABLED=1 \
    NEXT_PUBLIC_API_BASE_URL=${API_URL} \
    NEXT_PUBLIC_AZURE_CLIENT_ID=${AZURE_CLIENT_ID} \
    NEXT_PUBLIC_AZURE_TENANT_ID=${AZURE_TENANT_ID} \
    NEXT_PUBLIC_AZURE_REDIRECT_URI=${WEB_URL}

COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN npm run build

# ── Runner ───────────────────────────────────────────────────────────────────
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs \
 && adduser  --system --uid 1001 nextjs

# Copy standalone build output (next.config.ts sets output: 'standalone')
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static    ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public           ./public

USER nextjs

EXPOSE 3001

ENV PORT=3001 \
    HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
