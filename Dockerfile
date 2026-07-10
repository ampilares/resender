# syntax=docker/dockerfile:1

# resender — multi-stage build.
# All builder stages share the runtime base (node:20-slim, Debian) so the native
# better-sqlite3 binary compiled here is ABI-compatible with the final image.

# ---------------------------------------------------------------------------
# Stage 1: production dependencies (compiles better-sqlite3 from source).
# ---------------------------------------------------------------------------
FROM node:20-slim AS prod-deps
WORKDIR /app
# Build toolchain needed only to compile the better-sqlite3 native addon.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---------------------------------------------------------------------------
# Stage 2: build the admin web UI (Vite -> web/dist).
# ---------------------------------------------------------------------------
FROM node:20-slim AS web-build
WORKDIR /app/web
COPY web/package*.json ./
RUN npm install
COPY web/ ./
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 3: compile the server (tsc -> dist/).
# ---------------------------------------------------------------------------
FROM node:20-slim AS server-build
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc -p tsconfig.json

# ---------------------------------------------------------------------------
# Stage 4: runtime — slim image, production deps only, non-root.
# ---------------------------------------------------------------------------
FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV DATA_DIR=/data

# curl is optional; the HEALTHCHECK below uses node's built-in fetch instead.
COPY --from=prod-deps   /app/node_modules ./node_modules
COPY --from=server-build /app/dist        ./dist
COPY --from=web-build    /app/web/dist    ./web/dist
COPY package.json ./

# Data directory owned by the built-in non-root `node` user.
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME /data
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "const p=process.env.PORT||3000;fetch('http://127.0.0.1:'+p+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
