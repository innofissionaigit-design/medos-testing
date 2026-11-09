# MedOS web image (Next.js standalone output). Build from the repository root:  docker build -f docker/web.Dockerfile -t medos-web .
# Not built in the development environment (no Docker installed there); see docs/deployment.md.
FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true NEXT_TELEMETRY_DISABLED=1 NEXT_OUTPUT=standalone
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/web/package.json apps/web/
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
COPY packages/database/package.json packages/database/
RUN pnpm install --frozen-lockfile
COPY apps/web apps/web
RUN pnpm --filter @medos/web build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
# API_URL (server-side only) must point at the API service, e.g. http://api:4000/api/v1
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]
