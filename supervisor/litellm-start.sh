#!/usr/bin/env sh
# LiteLLM launcher. Regenerates the model list from GitHub Copilot's live
# catalog, then execs the proxy against the generated config.
#
# supervisord runs this as [program:litellm], so a `supervisorctl restart
# litellm` (which webapp/lib/supervisor.ts fires after sign-in and from the
# dashboard's refresh control) also re-discovers models.
set -e

# Never fatal: the generator degrades to a cached or bundled catalog on its
# own, but if it dies outright we still want the proxy up on whatever config
# was generated last time.
python3 /etc/litellm/generate_config.py || echo "[litellm-start] generator failed; using previous config"

if [ ! -f /data/litellm/config.generated.yaml ]; then
  echo "[litellm-start] no generated config; falling back to base (no models)"
  cp /etc/litellm/config.base.yaml /data/litellm/config.generated.yaml
fi

exec litellm --config /data/litellm/config.generated.yaml --host 0.0.0.0 --port 4000
