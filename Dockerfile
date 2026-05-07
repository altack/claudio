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
# `npm install` for first-time builds before anyone has generated one.
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

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

# Install Node 20 (to run the standalone Next.js server) and supervisor.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        ca-certificates curl gnupg supervisor \
 && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

# LiteLLM (proxy extras). Pin away from the compromised 1.82.7 / 1.82.8 line.
ARG LITELLM_VERSION=">=1.83.0,<2"
RUN pip install --no-cache-dir "litellm[proxy]${LITELLM_VERSION}"

# Webapp - copy the standalone Next.js output. The standalone server
# already includes a minimal node_modules tree.
WORKDIR /app
COPY --from=webapp-builder /build/.next/standalone ./
COPY --from=webapp-builder /build/.next/static ./.next/static
COPY --from=webapp-builder /build/public ./public

# LiteLLM + supervisor configs.
COPY litellm/config.yaml /etc/litellm/config.yaml
COPY litellm/spend_logger.py /etc/litellm/spend_logger.py
COPY supervisor/supervisord.conf /etc/supervisor/supervisord.conf

# Make /etc/litellm importable so `litellm_settings.callbacks: spend_logger.proxy_handler_instance`
# resolves at proxy startup.
ENV PYTHONPATH=/etc/litellm

# Data dirs (persisted via named volumes in compose.yaml).
RUN mkdir -p /data/copilot /data/litellm /data/claudex

EXPOSE 3000 4000

# supervisord runs both processes; -n keeps it in the foreground.
CMD ["supervisord", "-c", "/etc/supervisor/supervisord.conf", "-n"]
