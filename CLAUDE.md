# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

`claudio` routes Claude Code through a developer's GitHub Copilot subscription instead of the Anthropic API. One container, one image, one developer per install. See `README.md` for product framing and trade-offs (Copilot ToS gray area, translation fidelity, shadow cost, LiteLLM advisory pin).

## Common commands

Container lifecycle (PowerShell on Windows; works with `podman compose` and `docker compose`):

```pwsh
./scripts/setup.ps1            # idempotent first-time setup: build, up, install wrapper
podman compose up -d --build   # rebuild image after Dockerfile / litellm config change
podman compose restart claudio # pick up litellm/config.yaml edits without rebuilding
podman compose down            # stop; add -v to also drop the named volume (deletes tokens)
podman logs -f claudio         # combined supervisord output for both processes
./scripts/uninstall.ps1        # remove claudio.ps1 from ~/.claude/bin and PATH
```

Webapp (run **outside** the container only when iterating on the Next.js code; the proxy is reached over loopback so the dev server still needs the container running for `/api/*` routes that talk to LiteLLM):

```pwsh
cd webapp
npm install
npm run dev          # next dev on :3000
npm run build        # produces .next/standalone, which the Dockerfile copies
npm run lint         # next lint
npm run typecheck    # tsc --noEmit
```

There is no test suite and no top-level lint task. Don't invent one.

## Architecture

### Single-container, two-process layout

The image bundles **LiteLLM** (Python, `:4000`) and the **Next.js control panel** (Node, `:3000`) under `supervisord` as PID 1. `Dockerfile` is multi-stage: stage 1 runs `next build` with `output: "standalone"`; stage 2 is `python:3.12-slim` with Node 20 added so it can run `node /app/server.js`. `supervisor/supervisord.conf` defines the two `[program:*]` blocks and points the webapp at LiteLLM via `LITELLM_BASE_URL=http://127.0.0.1:4000`.

Ports are bound to `127.0.0.1` deliberately in `compose.yaml`. There is exactly one named volume, `claudio_copilot` mounted at `/data/copilot`, holding GitHub OAuth state. **Don't introduce Windows-path bind mounts** — Podman-on-WSL2 path translation and rootless UID mapping make them unreliable.

### The OAuth dance, and why it lives in the webapp

LiteLLM has its own `github_copilot/*` device-flow implementation. We re-implement the same flow in `webapp/lib/copilot-auth.ts` so the UI can show the user code, polling status, and re-auth/revoke controls. Both implementations write the **same files** to `/data/copilot`:

- `access-token` — bare GitHub OAuth access token
- `api-key.json` — JSON from `https://api.github.com/copilot_internal/v2/token`
- `.pending.json` — in-flight device flow state (only present mid-auth)

LiteLLM registers `github_copilot/*` deployments **at startup** against whatever tokens exist then. If the proxy boots before the user authorises, those routes are dead until restart. After a successful poll, `pollDeviceFlow()` calls `supervisorctl restart litellm` (best-effort, non-blocking) — preserve that behaviour if you change the auth flow.

`editorHeaders` in `copilot-auth.ts` (`editor-version: vscode/...`, `editor-plugin-version: copilot-chat/...`) are required by GitHub's Copilot endpoints. They impersonate the official VS Code Copilot client. Don't drop or "modernize" them without checking that the Copilot API still accepts the request.

### Model name aliasing — the load-bearing constraint

Claude Code's `/model` picker only adds entries from `/v1/models` whose IDs **start with `claude` or `anthropic`**. GitHub Copilot brokers the real Claude family on higher tiers, so `litellm/config.yaml` ships **1:1 pass-throughs** (e.g. `claude-opus-4.7 → github_copilot/claude-opus-4.7`) with no Messages↔OpenAI translation.

It also ships **dash-form duplicates** (`claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5`) because `claudio.ps1` sets `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL` to dashed IDs — without the duplicates, `/model opus|sonnet|haiku` resolves to a name the gateway doesn't serve. **Keep dotted and dashed aliases in sync** when editing `config.yaml`.

If translation ever does become necessary (e.g. routing to `gpt-*` Copilot models), `litellm_settings.drop_params: true` is what keeps OpenAI-only fields from leaking through.

### Webapp routing

Next.js 15 App Router. Pages: `/` (status grid + smoke test), `/auth`, `/models`, `/spend`. API routes live under `webapp/app/api/{auth,models,spend,status,smoke-test}` and are thin shells over `webapp/lib/litellm.ts` (admin API client) and `webapp/lib/copilot-auth.ts`.

`webapp/lib/config.ts` resolves env vars **per request, not at module load** — Next's "Collecting page data" build step evaluates modules without runtime env, so module-level `throw` on a missing var breaks `npm run build`. Use the `getLitellmMasterKey()` getter, not a top-level constant.

`getSpendByDay()` is normalisation-heavy on purpose: LiteLLM's spend log shape varies by version, and we run without a Prisma DB (the v1 image stays lean), so `/spend` only shows in-memory accumulation since the last LiteLLM restart. That is intentional, not a bug.

### The PowerShell wrapper

`scripts/claudio.ps1` is what makes `claudio` distinct from `claude`:

1. Reads master key from `~\.claudio\config.json` (written by `install-claudio.ps1`).
2. Smoke-tests `http://127.0.0.1:4000/health/liveliness` so a missing container produces a clear error before Claude Code starts up.
3. Sets `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, and the three `ANTHROPIC_DEFAULT_*_MODEL` vars, then `& claude @args`.

If you change a default model alias, update both `claudio.ps1` (env vars) **and** `litellm/config.yaml` (alias must exist).

## Editing rules

- **`.env`** — `LITELLM_MASTER_KEY` is mandatory. `setup.ps1` mints one if absent. Never commit a real value.
- **`compose.yaml`** — keep it portable across `podman compose` and `docker compose`. No Docker-only features. Named volumes only.
- **`Dockerfile`** — keep `LITELLM_VERSION` pinned to `>=1.83.0,<2` (the 1.82.7 / 1.82.8 PyPI releases were compromised).
