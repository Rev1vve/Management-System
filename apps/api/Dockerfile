FROM node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS api-build

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN apt-get update \
  && apt-get install --yes --no-install-recommends coreutils openssl \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable

WORKDIR /workspace

# Install dependencies first so the layer is cached across source-only changes.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY packages/config/package.json packages/config/package.json

RUN pnpm install --filter @project-operations/api... --frozen-lockfile

# Copy source, then generate the Prisma client (the generated output is
# gitignored and deliberately not part of the build context).
COPY apps/api apps/api
COPY packages/config packages/config

RUN pnpm --filter @project-operations/api exec prisma generate

RUN pnpm --filter @project-operations/api build

FROM api-build AS db-tools

WORKDIR /workspace/apps/api

# Entrypoint constructs DATABASE_URL from the mounted password secret.
ENTRYPOINT ["/bin/sh", "/workspace/apps/api/docker/db-tools-entrypoint.sh"]
CMD ["pnpm", "--version"]

FROM api-build AS api-deploy

RUN pnpm --filter @project-operations/api deploy --prod --legacy /runtime/api

FROM node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS api-runtime

ENV NODE_ENV="production"

RUN apt-get update \
  && apt-get install --yes --no-install-recommends coreutils openssl \
  && test -x /usr/bin/mv \
  && groupadd --gid 10001 app \
  && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin app \
  && install -d -o 10001 -g 10001 -m 0700 /srv/attachments \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=api-deploy /runtime/api/node_modules ./node_modules
COPY --from=api-build /workspace/apps/api/dist ./dist
COPY --from=api-build /workspace/apps/api/package.json ./package.json
COPY --from=api-build /workspace/apps/api/docker/db-tools-entrypoint.sh ./docker/db-tools-entrypoint.sh

USER 10001:10001

ENTRYPOINT ["/bin/sh", "/app/docker/db-tools-entrypoint.sh"]
CMD ["node", "dist/main.js"]
