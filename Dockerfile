# syntax=docker/dockerfile:1.6
#
# Single image bundling:
#   - LiteLLM proxy (Python, port 4000)
#   - Next.js control webapp (Node, port 3000)
#   - supervisord to run both processes in PID 1
#
# Multi-stage so the final image only ships runtime bits.

############################
# Stage 1 - build the webapp
############################
FROM node:20-bookworm-slim AS webapp-builder

WORKDIR /build

COPY webapp/package.json webapp/package-lock.json* ./
# Use `npm ci` when a lockfile is present (reproducible), fall back to
# `npm install` otherwise.
#
# The fallback also covers a lockfile npm rejects as out of sync. The repo
# doesn't track one, but CLAUDE.md tells you to `npm install` in webapp/ when
# iterating - and a lockfile written by a different npm minor than the one in
# this image resolves transitive peers differently (ajv 6 vs 8, for one), which
# makes `npm ci` refuse. A local dev artifact must not be able to break the
# image build.
RUN if [ -f package-lock.json ]; then \
      npm ci || { echo "lockfile rejected by npm ci; falling back to npm install"; npm install; }; \
    else npm install; fi

COPY webapp/ .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build


############################
# Stage 2 - runtime
############################
FROM python:3.12-slim-bookworm AS runtime

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1

# Transparent HTTP proxies (the corporate kind) routinely mangle Debian's pool
# responses — apt pipelines requests, the proxy returns them out of order or
# serves a different object entirely, and the build dies on "Hash Sum mismatch"
# somewhere in the middle. Turning off pipelining and proxy caching is the
# standard workaround; the retries cover ordinary mirror flakiness.
RUN printf '%s\n' \
      'Acquire::http::Pipeline-Depth "0";' \
      'Acquire::http::No-Cache "true";' \
      'Acquire::BrokenProxy "true";' \
      'Acquire::Retries "5";' \
      > /etc/apt/apt.conf.d/99claudio-net

# Install Node 20 (to run the standalone Next.js server) and supervisor.
#
# `apt-get clean` between attempts matters: a package that failed its hash check
# stays in the archive cache, so a plain retry re-uses the same bad file.
#
# The trailing `command -v` / `--version` calls are assertions — the retry loops
# swallow failures by design, and a half-installed image must not reach runtime.
# They live in the comment rather than inline because a `#` inside a line
# continuation is parsed inconsistently across BuildKit and buildah.
RUN set -eux; \
    for attempt in 1 2 3; do \
      apt-get update \
        && apt-get install -y --no-install-recommends \
             ca-certificates curl gnupg supervisor \
        && break; \
      echo "apt attempt ${attempt} failed; clearing caches and retrying"; \
      apt-get clean; \
      rm -rf /var/lib/apt/lists/*; \
      sleep 5; \
    done; \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -; \
    for attempt in 1 2 3; do \
      apt-get install -y --no-install-recommends nodejs && break; \
      echo "nodejs attempt ${attempt} failed; clearing caches and retrying"; \
      apt-get clean; \
      rm -rf /var/lib/apt/lists/*; \
      apt-get update; \
      sleep 5; \
    done; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*; \
    command -v supervisord; \
    command -v supervisorctl; \
    node --version

# LiteLLM (proxy extras).
#
# Lower bound: the 1.82.7 / 1.82.8 PyPI releases were compromised.
#
# Upper bound is not cosmetic. litellm 1.95.0 added
# proxy/management_endpoints/management_v1/common.py, which imports
# `get_flat_dependant` from fastapi at module scope — a symbol fastapi deleted
# in 0.140.7. litellm declares only `fastapi<1.0,>=0.136.3`, so pip is free to
# pair the two and the proxy then crash-loops on startup with:
#
#   ImportError: cannot import name 'get_flat_dependant'
#     from 'fastapi.dependencies.utils'
#
# Staying below 1.95 sidesteps it without us pinning fastapi as well. Lift the
# cap once litellm drops that import or tightens its own bound.
ARG LITELLM_VERSION=">=1.83.0,<1.95"

RUN pip install --no-cache-dir "litellm[proxy]${LITELLM_VERSION}"

# Import what the proxy loads at startup, so a bad dependency resolution fails
# the build instead of shipping an image that crash-loops behind supervisord.
RUN python -c "import litellm.proxy.proxy_server"

# Webapp - copy the standalone Next.js output. The standalone server
# already includes a minimal node_modules tree.
WORKDIR /app
COPY --from=webapp-builder /build/.next/standalone ./
COPY --from=webapp-builder /build/.next/static ./.next/static
COPY --from=webapp-builder /build/public ./public

# LiteLLM + supervisor configs.
#
# There is no static config.yaml: litellm-start.sh runs generate_config.py on
# every proxy start, which merges config.base.yaml with a model_list
# discovered from GitHub Copilot's live /models catalog and writes
# /data/litellm/config.generated.yaml. models.fallback.yaml is the snapshot
# used when the container boots before the user has signed in.
COPY litellm/config.base.yaml /etc/litellm/config.base.yaml
COPY litellm/models.fallback.yaml /etc/litellm/models.fallback.yaml
COPY litellm/generate_config.py /etc/litellm/generate_config.py
COPY litellm/spend_logger.py /etc/litellm/spend_logger.py
COPY supervisor/supervisord.conf /etc/supervisor/supervisord.conf
COPY supervisor/litellm-start.sh /usr/local/bin/litellm-start.sh
RUN chmod +x /usr/local/bin/litellm-start.sh

# Make /etc/litellm importable so `litellm_settings.callbacks: spend_logger.proxy_handler_instance`
# resolves at proxy startup.
ENV PYTHONPATH=/etc/litellm

# Data dirs (persisted via named volumes in compose.yaml).
RUN mkdir -p /data/copilot /data/litellm /data/claudio

EXPOSE 3000 4000

# supervisord runs both processes; -n keeps it in the foreground.
CMD ["supervisord", "-c", "/etc/supervisor/supervisord.conf", "-n"]
