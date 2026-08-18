# Development/tools image for the API. Used to run Prisma migrations, the
# idempotent seed, and the database integration tests inside the private
# Compose network (PostgreSQL has no host port mapping).
#
# This is a tools image, not the production API image: it keeps all dev
# dependencies (prisma CLI, tsx, vitest) so it can run migrate/seed/test.

FROM node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN corepack enable

WORKDIR /workspace

# Install dependencies first so the layer is cached across source-only changes.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/config/package.json packages/config/package.json

RUN pnpm install --frozen-lockfile

# Copy source, then generate the Prisma client (the generated output is
# gitignored and deliberately not part of the build context).
COPY apps/api apps/api
COPY packages/config packages/config

RUN pnpm --filter @project-operations/api exec prisma generate

WORKDIR /workspace/apps/api

# Entrypoint constructs DATABASE_URL from the mounted password secret.
ENTRYPOINT ["/bin/sh", "/workspace/apps/api/docker/db-tools-entrypoint.sh"]
CMD ["pnpm", "--version"]
