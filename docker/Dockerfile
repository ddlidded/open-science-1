# Open-Science — containerized web deployment with gateway authentication.
#
# Two stages:
#   1. build   — install deps, compile the standalone Node backend + web UI, stage
#                the self-contained runtime tree at out/standalone (linux micromamba
#                included via scripts/fetch-micromamba.mjs).
#   2. runtime — slim Node image running the backend on loopback plus the auth
#                gateway (login + admin user management) as the only public port.
#
# Build:  docker build -f docker/Dockerfile -t open-science-web .
# Run:    docker run -p 8080:8080 -e ADMIN_PASSWORD=changeme -v os-data:/data open-science-web

# ───────────────────────────── build stage ─────────────────────────────
FROM node:24-bookworm AS build
WORKDIR /src

# Manifest files first for layer caching.
COPY package.json package-lock.json ./
COPY packages ./packages
COPY prisma ./prisma
COPY patches ./patches
COPY scripts ./scripts
COPY build ./build
COPY resources ./resources
COPY cli ./cli
COPY .github ./.github
COPY tsconfig*.json electron.vite.config.ts vite.web.config.ts ./

# Install without the desktop-oriented postinstall; run only the pieces the
# headless backend needs (patches, prisma client, pinned native components).
RUN npm ci --ignore-scripts --no-audit --no-fund \
 && node scripts/prepare-shadcn-patch.mjs \
 && npx patch-package --error-on-fail \
 && node scripts/check-claude-acp-patch.mjs \
 && npx prisma generate \
 && node scripts/install-native-components.mjs \
 && npm run build:packages

# Application sources.
COPY src ./src
COPY AGENTS.md CONTRIBUTING.md LICENSE README.md ./

# Compile backend + web, fetch the pinned linux micromamba, stage the runtime.
RUN npm run build:backend:compiled \
 && npm run build:web:compiled \
 && node scripts/fetch-micromamba.mjs linux-64 resources/bin/linux/x64/micromamba \
 && node scripts/stage-backend.mjs

# ───────────────────────────── runtime stage ─────────────────────────────
FROM node:24-bookworm-slim

# libssl3 + openssl let Prisma detect the debian-openssl-3.0.x engine at runtime;
# ca-certificates for TLS to MCP/API endpoints.
# bubblewrap is setuid root so the notebook kernel sandbox can mount inside its own namespace.
# setuid lets bwrap operate as init-userns root, which sidesteps the MNT_LOCKED mounts that
# blocked the unprivileged-userns path; the container must still run with the seccomp and
# AppArmor relaxations shown in docker-compose.yml.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libssl3 openssl ca-certificates bubblewrap \
 && chmod u+s /usr/bin/bwrap \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    DATA_DIR=/data \
    HOME=/data/home \
    OPEN_SCIENCE_CONFIG_ROOT=/data/open-science \
    GATEWAY_PORT=8080 \
    UPSTREAM_URL=http://127.0.0.1:44100

WORKDIR /opt
COPY --from=build /src/out/standalone /opt/open-science
COPY docker/auth-gateway /opt/auth-gateway
RUN cd /opt/auth-gateway && npm install --omit=dev --no-audit --no-fund
COPY docker/entrypoint.sh /opt/entrypoint.sh
RUN chmod +x /opt/entrypoint.sh && mkdir -p /data

VOLUME ["/data"]
EXPOSE 8080

# Run as a non-root user; /data is the only writable path the app needs and it
# is also HOME — so npm-installed agent CLIs (~/.local), CLI auth profiles
# (~/.claude, ~/.devin, ~/.codex) and app state all persist on the volume.
# NPM_CONFIG_PREFIX + PATH make `npm i -g` land in the user prefix (the same
# fallback the app uses for non-writable prefixes).
RUN useradd --create-home --uid 1001 openscience \
 && mkdir -p /data/home/.local/bin /opt/npm-global \
 && chown -R openscience /home/openscience /data /opt/auth-gateway \
 && npm i -g --prefix /opt/npm-global devin@3000.11.234 --no-audit --no-fund
ENV NPM_CONFIG_PREFIX=/data/home/.local \
    PATH=/data/home/.local/bin:/opt/npm-global/bin:$PATH
USER openscience

ENTRYPOINT ["/opt/entrypoint.sh"]
