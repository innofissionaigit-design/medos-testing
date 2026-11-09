# MedOS API image. Build from the repository root:  docker build -f docker/api.Dockerfile -t medos-api .
# The same image runs migrations (see docker-compose.yml, service "migrate") because it carries the Prisma CLI.
# Never built in the development environment (no Docker there): the "docker" job in .github/workflows/ci.yml builds and
# starts it on every change; see docs/deployment.md.
FROM node:22-bookworm-slim AS build
# pnpm is prepared into a directory every user can read: the container runs as "node", not root, and the migration job
# (`pnpm --filter @medos/database migrate`) would otherwise try to download pnpm again when it starts.
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true COREPACK_HOME=/opt/corepack COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/* \
 && corepack enable && corepack prepare pnpm@9.15.9 --activate && chmod -R a+rX /opt/corepack
WORKDIR /repo

# Dependency layer: only manifests, so source edits do not reinstall packages. Every workspace manifest is present so the
# lockfile matches; --filter then installs only what the API needs.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/database/package.json packages/database/
RUN pnpm install --frozen-lockfile --filter "@medos/api..."

COPY apps/api apps/api
COPY packages packages
# Builds shared + database (prisma generate) + api in dependency order.
RUN pnpm --filter @medos/api... build

FROM build AS runtime
ENV NODE_ENV=production PORT=4000 STORAGE_DIR=/data/files
# /data/files is where patient files go with STORAGE_DRIVER=local. Created here, owned by "node", so a volume mounted on it
# starts out writable by the API. (With STORAGE_DRIVER=s3 it is unused.)
RUN mkdir -p /data/files && chown -R node:node /repo /data
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/api/dist/main.js"]
