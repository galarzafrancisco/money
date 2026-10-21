# Money backend container image. Built and pushed by .github/workflows/ci.yml
# (see docs/ci.md). Targets linux/arm64 (DGX Spark).

# Build stage
FROM node:24-alpine AS builder

WORKDIR /workdir

# Package manifests first, so the dependency layer is cached across source changes
COPY package*.json ./
COPY apps/backend/package.json ./apps/backend/
COPY apps/web/package.json ./apps/web/
COPY packages/auth/package.json ./packages/auth/
COPY packages/client/package.json ./packages/client/

RUN --mount=type=cache,target=/root/.npm npm ci

COPY . .

# Nx order: @taico/auth → backend (also writes openapi.json) → @money/client (generated
# from the spec) → web app (Vite bundle that the backend serves at /)
RUN npx nx run-many -t build -p @money/backend @money/web --skip-nx-cache

# Production stage
FROM node:24-alpine

WORKDIR /workdir

ENV NODE_ENV=production
ENV PORT=4180

COPY package*.json ./
COPY apps/backend/package.json ./apps/backend/
COPY apps/web/package.json ./apps/web/
COPY packages/auth/package.json ./packages/auth/
COPY packages/client/package.json ./packages/client/

# Production dependencies only (the web app is a static bundle and needs none); @taico/auth resolves through the workspace symlink
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

COPY --from=builder /workdir/packages/auth/dist ./packages/auth/dist
COPY --from=builder /workdir/apps/backend/dist ./apps/backend/dist
# Served by the backend at / (src/web-app/serve-web-app.ts), same origin as /api and /auth
COPY --from=builder /workdir/apps/web/dist ./apps/web/dist

# The base image's `node` user, by number (uid=1000 gid=1000 in node:24-alpine;
# CI checks this). Kubernetes runAsNonRoot can only verify a numeric user:
# `USER node` makes the kubelet refuse to start the container. App files stay
# root-owned and read-only; the only writable path at runtime is /tmp.
USER 1000:1000

EXPOSE 4180

WORKDIR /workdir/apps/backend
CMD ["node", "dist/main.js"]
