# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

`claudio` routes Claude Code through a developer's GitHub Copilot subscription instead of the Anthropic API. One container, one image, one developer per install. See `README.md` for product framing and trade-offs (Copilot ToS gray area, shadow cost, LiteLLM advisory pin).

## Common commands

Container lifecycle (PowerShell on Windows; works with `podman compose` and `docker compose`):

```pwsh
./scripts/setup.ps1            # idempotent first-time setup: build, up, install wrapper
podman compose up -d --build   # rebuild image after Dockerfile / litellm config change
podman compose restart claudio # pick up litellm/config.base.yaml edits without rebuilding
podman compose down            # stop; add -v to also drop the named volumes (deletes tokens)
podman logs -f claudio         # combined supervisord output for both processes
./scripts/uninstall.ps1        # remove claudio.ps1 from ~/.claude/bin and PATH
```

Webapp (run **outside** the container only when iterating on the Next.js code; the proxy is reached over loopback so the dev server still needs the container running for `/api/*` routes that talk to LiteLLM):

```pwsh
cd webapp
npm install
npm run dev          # next dev on :3000
npm run build        # produces .next/standalone, which the Dockerfile copies
npm run lint         # eslint .
npm run typecheck    # tsc --noEmit
```

There is no test suite and no top-level lint task. Don't invent one.

Re-discovering models is a LiteLLM restart, not a rebuild: the **refresh** control in the dashboard's models section, `POST /api/models/refresh`, or `supervisorctl restart litellm` inside the container.

## Architecture

### Single-container, two-process layout

The image bundles **LiteLLM** (Python, `:4000`) and the **Next.js control panel** (Node, `:3000`) under `supervisord` as PID 1. `Dockerfile` is multi-stage: stage 1 runs `next build` with `output: "standalone"`; stage 2 is `python:3.12-slim` with Node 20 added so it can run `node /app/server.js`. `supervisor/supervisord.conf` defines the two `[program:*]` blocks and points the webapp at LiteLLM via `LITELLM_BASE_URL=http://127.0.0.1:4000`.

LiteLLM is not started directly. `[program:litellm]` runs `supervisor/litellm-start.sh`, which regenerates the model list (below) and then execs the proxy. That indirection is what makes a restart equal a catalog refresh.

Ports are bound to `127.0.0.1` deliberately in `compose.yaml`. Three named volumes: `claudio_copilot` at `/data/copilot` (GitHub OAuth state), `claudio_litellm` at `/data/litellm` (generated config, model cache, spend JSONL), `claudio_app` at `/data/claudio` (preferences). **Don't introduce Windows-path bind mounts** — Podman-on-WSL2 path translation and rootless UID mapping make them unreliable.

### The OAuth dance, and why it lives in the webapp

LiteLLM has its own `github_copilot/*` device-flow implementation. We re-implement the same flow in `webapp/lib/copilot-auth.ts` so the UI can show the user code, polling status, and re-auth/revoke controls. Both implementations write the **same files** to `/data/copilot`:

- `access-token` — bare GitHub OAuth access token
- `api-key.json` — JSON from `https://api.github.com/copilot_internal/v2/token`
- `.pending.json` — in-flight device flow state (only present mid-auth)

LiteLLM registers `github_copilot/*` deployments **at startup** against whatever tokens exist then. If the proxy boots before the user authorises, those routes are dead until restart — and the model catalog can't be discovered either. After a successful poll, `pollDeviceFlow()` calls `restartLitellm()` from `webapp/lib/supervisor.ts` (best-effort, non-blocking) — preserve that behaviour if you change the auth flow.

`editorHeaders` in `copilot-auth.ts` (`editor-version: vscode/...`, `editor-plugin-version: copilot-chat/...`) are required by GitHub's Copilot endpoints. They impersonate the official VS Code Copilot client. `EDITOR_HEADERS` in `litellm/generate_config.py` is the same set — **change both together**. Don't drop or "modernize" them without checking that the Copilot API still accepts the request.

### Model discovery — there is no static model list

**Never hardcode a model name.** `litellm/config.yaml` no longer exists. Instead:

- `litellm/config.base.yaml` holds everything except `model_list`.
- `litellm/generate_config.py` runs on every proxy start, reads GitHub Copilot's live catalog (`GET {api_base}/models`, authenticated with `/data/copilot/api-key.json`, refreshing that key from `access-token` when stale), and writes the merged result to `/data/litellm/config.generated.yaml` — the file LiteLLM actually boots against.
- Fallback chain, so boot never blocks: live catalog → `/data/litellm/models.cache.json` (last good) → `litellm/models.fallback.yaml` (bundled snapshot, used on a fresh install before sign-in).

The load-bearing constraint the generator enforces: Claude Code's `/model` picker only adds entries from `/v1/models` whose IDs **start with `claude` or `anthropic`**. So `alias_for()` passes Anthropic IDs through 1:1 (`claude-opus-5` → `github_copilot/claude-opus-5`) and prefixes everything else as `claude-via-<id>`. It also mints a **dash-form twin** of every dotted Anthropic alias (`claude-opus-4.8` → `claude-opus-4-8`), because `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL` use dashes.

LiteLLM's own `check_provider_endpoint` model discovery does **not** cover `github_copilot`, and would expose IDs as `github_copilot/…` which the picker rejects. That's why this is hand-rolled.

Tier defaults are resolved, not stored. `webapp/lib/models.ts` (pure — no `node:` imports, shared by server and client) parses versions out of aliases and picks the newest per family; `preferences.json` stores the literal `"auto"` by default. `GET /api/preferences` returns *resolved* aliases; `?format=env` returns them as `KEY=value` lines for the wrapper scripts.

If translation ever does become necessary (e.g. routing to `gpt-*` Copilot models), `litellm_settings.drop_params: true` is what keeps OpenAI-only fields from leaking through.

### Usage accounting

`litellm/spend_logger.py` appends one JSONL record per request to `/data/litellm/spend.jsonl`; `webapp/lib/usage.ts` reads it. Record schema is **v2**; readers reject anything older. Three invariants, each because v1 got it wrong:

- **Every record carries LiteLLM's call id, and duplicates are dropped** — on write *and* on read. LiteLLM drives the sync and the async success handler for one async call, so a naive logger writes everything twice.
- **`count_tokens` and other non-generation call types are never logged.** Claude Code measures its context constantly; those measurements aren't consumption.
- **Tokens are split, never summed.** `input_tokens` is fresh context only; `cache_read_tokens` / `cache_write_tokens` are separate fields. Anthropic's `prompt_tokens` folds cache reads in at full weight and Claude Code re-sends its whole conversation every turn, so `sum(prompt_tokens)` overstates real usage by an order of magnitude. The dashboard's headline "tokens" is `input + output`.

Timing: `duration_ms` is the whole call, `ttft_ms` is time-to-first-token. For a streamed answer the wall clock measures how long the model talked, not latency, so the UI shows TTFT.

Buckets are anchored to a **caller-supplied IANA timezone**, not the container's UTC. The browser sends `?tz=` on every `/api/dashboard` fetch and the server buckets with `Intl.DateTimeFormat`, so DST is handled. Server-rendered HTML uses `CLAUDIO_TZ` (default UTC) and is corrected by the client's first fetch on mount.

### Webapp routing

Next.js App Router. Two pages: `/` (the consolidated dashboard) and `/onboarding` (the device-flow wizard). API routes under `webapp/app/api/{auth,chat,dashboard,models,preferences,session,smoke-test,status}` are thin shells over `webapp/lib/{litellm,copilot-auth,usage,preferences,catalog,supervisor}.ts`. `/api/dashboard` is the single endpoint the page polls.

`webapp/lib/config.ts` resolves env vars **per request, not at module load** — Next's "Collecting page data" build step evaluates modules without runtime env, so a module-level `throw` on a missing var breaks `npm run build`. Use the `getLitellmMasterKey()` getter, not a top-level constant.

Anything the client bundle needs from the model logic lives in `webapp/lib/models.ts`, which imports nothing. `lib/preferences.ts` pulls in `node:fs` and must never reach a `"use client"` module.

### The PowerShell wrapper

`scripts/claudio.ps1` is what makes `claudio` distinct from `claude`:

1. Reads master key from `~\.claudio\config.json` (written by `install-claudio.ps1`).
2. Smoke-tests `http://127.0.0.1:4000/health/liveliness` so a missing container produces a clear error before Claude Code starts up.
3. Fetches `GET /api/preferences?format=env` for the three `ANTHROPIC_DEFAULT_*_MODEL` values, caches them to `~\.claudio\defaults.env`, and falls back to that cache when the webapp is unreachable. **No model name is hardcoded in the wrapper.** With neither a response nor a cache it warns and leaves the vars unset — a wrong pin fails more confusingly than no pin.
4. Sets `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` and whichever model vars it resolved, then `& claude @args`, restoring the previous environment in a `finally`.

`scripts/claudio.sh` is the POSIX equivalent and must stay behaviourally identical.

## Editing rules

- **`.env`** — `LITELLM_MASTER_KEY` is mandatory. `setup.ps1` mints one if absent. Never commit a real value.
- **`compose.yaml`** — keep it portable across `podman compose` and `docker compose`. No Docker-only features. Named volumes only.
- **`Dockerfile`** — keep `LITELLM_VERSION` pinned to `>=1.83.0,<1.95`. The floor avoids the compromised 1.82.7 / 1.82.8 PyPI releases; the ceiling avoids 1.95.0, which started importing fastapi's `get_flat_dependant` at module scope — a symbol fastapi deleted in 0.140.7 — while still declaring a bound (`fastapi<1.0`) loose enough for pip to pair the two, which crash-loops the proxy. The `python -c "import litellm.proxy.proxy_server"` line right after the install turns that class of failure into a failed build instead of a broken image.
- **`litellm/config.base.yaml`** — no `model_list` here; the generator would overwrite it.
- **Model names** — if you find yourself typing `claude-opus-…` anywhere outside `litellm/models.fallback.yaml`, stop. The whole point is that the list comes from Copilot.
