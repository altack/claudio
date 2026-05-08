# claudio

**Claude Code for the rest of us.**

Your company did the math: a GitHub Copilot seat per dev is cheaper than a Claude Max seat per dev, so guess which one finance approved. claudio is the bridge — it takes the Copilot subscription you already have and points Claude Code at it, giving you the agentic CLI experience without a second invoice, a second SSO integration, or another awkward conversation with your manager.

Works great on that HP laptop IT handed you.

---

Under the hood: each developer runs a small local container that exposes a [LiteLLM](https://docs.litellm.ai/) proxy translating Anthropic's Messages API to Copilot's OpenAI-shaped backend, plus a Next.js control panel for OAuth, model selection, and shadow-cost tracking.

A `claudio` PowerShell wrapper switches Claude Code over to the proxy on demand:

```pwsh
claude       # talks to Anthropic as usual
claudio      # talks to GitHub Copilot via the local LiteLLM proxy
```

## What's in here

```
.
├── compose.yaml            # podman compose / docker compose
├── Dockerfile              # one image: LiteLLM + Next.js (supervisord)
├── litellm/config.yaml     # claude-* alias map -> github_copilot/*
├── supervisor/             # supervisord config
├── webapp/                 # Next.js control panel
└── scripts/                # setup.{ps1,sh}, claudio.{ps1,sh}, install/uninstall
```

## Prerequisites

- **Podman Desktop** (recommended) or **Docker Desktop** — Windows, Linux, or WSL2
- **Claude Code** installed on the host
- An active **GitHub Copilot subscription** (your own seat)

> Podman is the primary target. The compose file avoids Docker-only features and uses named volumes (no host bind mounts), which sidesteps Podman-on-WSL2's weakest spots.

## Setup

**Windows (PowerShell):**

```pwsh
./scripts/setup.ps1
```

**Linux / WSL (bash):**

```bash
./scripts/setup.sh
```

The setup script will:

1. Detect `podman` (preferred) or `docker`.
2. Mint a random `LITELLM_MASTER_KEY` in `.env` if missing.
3. Build the image and start the container.
4. Install the `claudio` wrapper and put it on your `PATH`
   (`~/.claude/bin` on Windows, `~/.local/bin` on Linux/WSL).
5. Open the control panel at <http://localhost:3000>.

From there:

- Click **Sign in with GitHub** to run the OAuth device flow.
- The control panel polls until your Copilot tokens are minted.
- Run `claudio` in a fresh terminal.

## Daily usage

| Need | Command |
|---|---|
| Use Claude Code via Copilot | `claudio` |
| Use Claude Code as usual | `claude` |
| Open the control panel | <http://localhost:3000> |
| Stop everything | `podman compose down` |

<img width="1012" height="1617" alt="image" src="https://github.com/user-attachments/assets/f455c8e8-2cf0-42fe-88da-76424449e88b" />  

## Architecture

```
┌─────────────────────────────────────────────┐
│  PowerShell                                 │
│  claudio  ──► claude (ANTHROPIC_BASE_URL=   │
│                       http://localhost:4000)│
└─────────────────────────────────────────────┘
                       │
                       ▼   /v1/messages (Anthropic format)
┌─────────────────────────────────────────────┐
│  Container: claudio                         │
│                                             │
│  :4000  LiteLLM ──► GitHub Copilot API     │
│         translates Messages ↔ OpenAI Chat   │
│                                             │
│  :3000  Next.js control panel               │
│         OAuth wizard, models, spend         │
│                                             │
│  /data/copilot   (named vol, OAuth tokens)  │
│  /data/litellm   (named vol, spend SQLite)  │
└─────────────────────────────────────────────┘
```

### Model name aliasing

Claude Code's `/v1/models` discovery only adds models whose IDs start with `claude` or `anthropic`. Copilot returns `gpt-4`, `gpt-5.1-codex`, etc., so `litellm/config.yaml` aliases them:

```yaml
- model_name: claude-opus-4-7
  litellm_params:
    model: github_copilot/gpt-5.1-codex
- model_name: claude-sonnet-4-6
  litellm_params:
    model: github_copilot/gpt-5.1-codex
- model_name: claude-haiku-4-5
  litellm_params:
    model: github_copilot/gpt-4
```

Edit `litellm/config.yaml` and `podman compose restart claudio` to change the mapping. (UI-driven editing is on the v2 list.)

## Trade-offs to know about

- **Translation fidelity.** LiteLLM's Anthropic-unified endpoint translates Messages ↔ OpenAI Chat. Tool use works. Anthropic-specific features — extended thinking, prompt caching, fine-grained beta headers — won't translate cleanly.
- **GitHub Copilot ToS.** Copilot's terms restrict usage to "supported IDEs and integrations." Routing through a third-party CLI is a gray area. Decide for yourself.
- **Cost framing.** Copilot is flat-rate, so "real" cost is constant. The `usage` section shows **shadow cost** — what these tokens *would* cost on the Anthropic API.
- **No database (striclty speaking).** Usage is stored on a file, removing the stored container will wipe all history
- **LiteLLM security advisory.** Versions 1.82.7 and 1.82.8 were compromised on PyPI. The Dockerfile pins `>=1.83.0` by default.

## Troubleshooting (Podman on Windows)

- **`Error: short-name resolution enforced`** — you're on rootful Podman with strict short-name policy. Run `podman compose build` first, or set `short-name-mode = "permissive"` in your registries config.
- **Container starts but `:3000` / `:4000` aren't reachable.** Check Podman Machine port forwarding: `podman machine inspect | rg PortForwarding`. The compose file binds to `127.0.0.1` deliberately — confirm nothing else is on those ports.
- **OAuth device flow appears to hang.** The control panel polls every 5s; LiteLLM's authenticator polls GitHub's token endpoint at the interval GitHub returns. Give it ~30s before assuming something's wrong, then check `podman logs claudio`.
- **`podman compose` not found.** Install `podman-compose` (`pip install podman-compose`) or use Podman Desktop's bundled compose provider.

## Tear down

```pwsh
# Windows
./scripts/uninstall.ps1   # removes wrapper from PATH
```

```bash
# Linux / WSL
./scripts/uninstall.sh    # removes wrapper from PATH
```

```bash
podman compose down -v    # stops container and removes volumes (deletes tokens!)
```
