// Server-side runtime config. Resolved per request, NOT at module load -
// Next.js's "Collecting page data" build step evaluates modules without
// the runtime env, so module-level throws break `npm run build`.

// `||` not `??` because compose.yaml passes ${VAR:-} for optional overrides,
// which arrives as an empty string when unset - and `??` would keep it.
export const LITELLM_BASE_URL =
  process.env.LITELLM_BASE_URL || "http://127.0.0.1:4000";

export function getLitellmMasterKey(): string {
  const v = process.env.LITELLM_MASTER_KEY;
  if (!v) throw new Error("Missing required env var: LITELLM_MASTER_KEY");
  return v;
}

export const COPILOT_TOKEN_DIR =
  process.env.GITHUB_COPILOT_TOKEN_DIR || "/data/copilot";

// VS Code's public Copilot OAuth client id. LiteLLM uses the same value.
export const COPILOT_CLIENT_ID =
  process.env.GITHUB_COPILOT_CLIENT_ID || "Iv1.b507a08c87ecfe98";

// Default endpoints; overridable for GitHub Enterprise.
export const GITHUB_DEVICE_CODE_URL =
  process.env.GITHUB_COPILOT_DEVICE_CODE_URL ||
  "https://github.com/login/device/code";

export const GITHUB_ACCESS_TOKEN_URL =
  process.env.GITHUB_COPILOT_ACCESS_TOKEN_URL ||
  "https://github.com/login/oauth/access_token";

export const COPILOT_API_KEY_URL =
  process.env.GITHUB_COPILOT_API_KEY_URL ||
  "https://api.github.com/copilot_internal/v2/token";
