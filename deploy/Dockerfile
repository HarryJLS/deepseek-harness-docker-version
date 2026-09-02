# syntax=docker/dockerfile:1.7
# ---------------------------------------------------------------------------
# DeepSeek Harness — containerized build.
#
# Stage 1 (build)  : pnpm install + full repo build, producing lib/ artifacts.
# Stage 2 (runtime): slim image carrying the built workspace plus a pnpm that
#                    can install plugin bundles from an npm registry at boot.
#
# The build context is the repository root, which carries both the sources and
# the deploy assets.
#
#   docker build -f deploy/Dockerfile -t dsh .
# ---------------------------------------------------------------------------

FROM node:24-bookworm AS build

# The build context excludes .git, so the client build metadata that would come
# from `git rev-parse HEAD` is supplied explicitly. `repositoryCommitHash` reads
# this variable first and only shells out to git when it is absent.
ARG DSH_CLIENT_COMMIT_HASH

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=1 \
    DSH_CLIENT_COMMIT_HASH=${DSH_CLIENT_COMMIT_HASH}

RUN corepack enable && corepack prepare pnpm@11.7.0 --activate

WORKDIR /src

# pnpm resolves workspace globs during install, so the whole checkout has to be
# present before it runs; splitting the manifests into their own layer would
# not produce a reusable cache here.
COPY . ./

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

RUN pnpm run build

# ---------------------------------------------------------------------------

FROM node:24-bookworm-slim AS runtime

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NODE_ENV=production \
    DSH_HOME=/var/lib/dsh

# pnpm stays in the runtime image on purpose: `dsh plugin add` shells out to it
# to install the deployment's plugin roster from the registry at start.
RUN corepack enable && corepack prepare pnpm@11.7.0 --activate \
    && apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates dumb-init curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /src /app
COPY deploy/deploy-entrypoint.sh deploy/prepare-profile.mjs /usr/local/bin/
RUN chmod +x /usr/local/bin/deploy-entrypoint.sh && mkdir -p "$DSH_HOME"

# The bind, the access gates, and the Nacos/OceanBase coordinates come from
# the dsh-bundle-docker layer that the entrypoint selects into the profile.
ENV DSH_BIN=/app/apps/cli/lib/bin.js \
    DSH_PROFILE=web \
    DSH_PORT=3080

EXPOSE 3080
ENTRYPOINT ["dumb-init", "--", "/usr/local/bin/deploy-entrypoint.sh"]
