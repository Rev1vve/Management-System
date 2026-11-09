FROM node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS web-build

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV NEXT_TELEMETRY_DISABLED=1
ENV NEXT_OUTPUT_STANDALONE=true

RUN apt-get update \
  && apt-get install --yes --no-install-recommends coreutils \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable

WORKDIR /workspace

# Dependencies first so source-only changes reuse the layer.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/design-tokens/package.json packages/design-tokens/package.json

RUN pnpm install --filter @project-operations/web... --frozen-lockfile

COPY apps/web apps/web
COPY packages/config packages/config
COPY packages/design-tokens packages/design-tokens

# public 可能为空目录甚至不存在，但 runtime 阶段会 COPY 它，所以先保证存在。
RUN mkdir -p apps/web/public \
  && pnpm --filter @project-operations/web build

FROM node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS web-runtime

ENV NODE_ENV="production"
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN apt-get update \
  && apt-get install --yes --no-install-recommends coreutils \
  && groupadd --gid 10001 app \
  && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin app \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Next standalone 自带 server.js 与裁剪后的 node_modules。
COPY --from=web-build --chown=10001:10001 /workspace/apps/web/.next/standalone ./
COPY --from=web-build --chown=10001:10001 /workspace/apps/web/.next/static ./apps/web/.next/static
COPY --from=web-build --chown=10001:10001 /workspace/apps/web/public ./apps/web/public

USER 10001:10001

EXPOSE 3000

CMD ["node", "apps/web/server.js"]
