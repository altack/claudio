// GitHub Copilot OAuth device flow. Implements the same dance LiteLLM does
// internally so we get UI control over the flow (showing the device code,
// status, etc.). Tokens are written to the same files LiteLLM reads:
//
//   $COPILOT_TOKEN_DIR/access-token    bare GitHub OAuth access token
//   $COPILOT_TOKEN_DIR/api-key.json    JSON returned by the Copilot
//                                      copilot_internal/v2/token endpoint
//
// State for an in-progress device flow lives in $COPILOT_TOKEN_DIR/.pending.json
// so the polling endpoint can pick up where /login left off.

import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import {
  COPILOT_API_KEY_URL,
  COPILOT_CLIENT_ID,
  COPILOT_TOKEN_DIR,
  GITHUB_ACCESS_TOKEN_URL,
  GITHUB_DEVICE_CODE_URL,
} from "./config";

const ACCESS_TOKEN_FILE = "access-token";
const API_KEY_FILE = "api-key.json";
const PENDING_FILE = ".pending.json";

const editorHeaders = {
  "editor-version": "vscode/1.85.1",
  "editor-plugin-version": "copilot-chat/0.12.0",
  "user-agent": "GitHubCopilotChat/0.12.0",
  accept: "application/json",
} as const;

export type DeviceCodeStart = {
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
};

type Pending = {
  device_code: string;
  interval: number;
  expires_at: number;
  next_poll_after?: number; // unix seconds; honour slow_down responses
};

type GitHubTokenResponse =
  | { access_token: string; token_type: string; scope: string }
  | {
      error:
        | "authorization_pending"
        | "slow_down"
        | "expired_token"
        | "access_denied";
      error_description?: string;
      interval?: number; // present on slow_down responses
    };

type CopilotApiKey = {
  token: string;
  expires_at: number;
  refresh_in?: number;
  [k: string]: unknown;
};

const tokenPath = (file: string) => path.join(COPILOT_TOKEN_DIR, file);

async function ensureDir(): Promise<void> {
  await fs.mkdir(COPILOT_TOKEN_DIR, { recursive: true });
}

async function readJson<T>(p: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(p, "utf8");
    return JSON.parse(raw) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function writeJson(p: string, data: unknown): Promise<void> {
  await fs.writeFile(p, JSON.stringify(data, null, 2), "utf8");
}

async function safeUnlink(p: string): Promise<void> {
  try {
    await fs.unlink(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/** Kick off the device flow. Returns codes the user needs to act on. */
export async function startDeviceFlow(): Promise<DeviceCodeStart> {
  await ensureDir();

  const res = await fetch(GITHUB_DEVICE_CODE_URL, {
    method: "POST",
    headers: { ...editorHeaders, "content-type": "application/json" },
    body: JSON.stringify({ client_id: COPILOT_CLIENT_ID, scope: "read:user" }),
  });

  if (!res.ok) {
    throw new Error(
      `Device code request failed: ${res.status} ${await res.text()}`,
    );
  }

  const body = (await res.json()) as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    expires_in: number;
    interval: number;
  };

  const pending: Pending = {
    device_code: body.device_code,
    interval: body.interval,
    expires_at: Math.floor(Date.now() / 1000) + body.expires_in,
  };
  await writeJson(tokenPath(PENDING_FILE), pending);

  return {
    user_code: body.user_code,
    verification_uri: body.verification_uri,
    expires_in: body.expires_in,
    interval: body.interval,
  };
}

export type PollResult =
  | { status: "no_flow" }
  | { status: "pending" }
  | { status: "expired" }
  | { status: "denied" }
  | { status: "authorized" };

/** One non-blocking poll attempt. Frontend should call this on an interval. */
export async function pollDeviceFlow(): Promise<PollResult> {
  const pending = await readJson<Pending>(tokenPath(PENDING_FILE));
  if (!pending) return { status: "no_flow" };

  const nowSec = Math.floor(Date.now() / 1000);
  if (nowSec > pending.expires_at) {
    await safeUnlink(tokenPath(PENDING_FILE));
    return { status: "expired" };
  }

  // Respect any back-off GitHub asked for on a previous slow_down response.
  if (pending.next_poll_after && nowSec < pending.next_poll_after) {
    return { status: "pending" };
  }

  const res = await fetch(GITHUB_ACCESS_TOKEN_URL, {
    method: "POST",
    headers: { ...editorHeaders, "content-type": "application/json" },
    body: JSON.stringify({
      client_id: COPILOT_CLIENT_ID,
      device_code: pending.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
  });

  if (!res.ok) {
    throw new Error(
      `Token poll failed: ${res.status} ${await res.text()}`,
    );
  }

  const body = (await res.json()) as GitHubTokenResponse;

  // Goes to stderr -> visible in `podman logs claudio` so we can see exactly
  // what GitHub said when something's misbehaving.
  console.error("[poll]", JSON.stringify(body));

  if ("error" in body) {
    if (body.error === "authorization_pending" || body.error === "slow_down") {
      // GitHub bumps `interval` when rate-limiting. Persist a no-poll-before
      // timestamp so subsequent calls (UI auto-poll, manual tests, retries)
      // can't pile on and dig us deeper.
      const bumpedInterval = body.interval ?? pending.interval;
      pending.interval = bumpedInterval;
      pending.next_poll_after = nowSec + bumpedInterval;
      await writeJson(tokenPath(PENDING_FILE), pending);
      return { status: "pending" };
    }
    if (body.error === "expired_token") {
      await safeUnlink(tokenPath(PENDING_FILE));
      return { status: "expired" };
    }
    if (body.error === "access_denied") {
      await safeUnlink(tokenPath(PENDING_FILE));
      return { status: "denied" };
    }
    throw new Error(`Unexpected device-flow error: ${body.error}`);
  }

  // Got the GitHub OAuth access token. Persist it and exchange for a Copilot
  // API key in one shot, so a successful poll leaves the proxy fully ready.
  await fs.writeFile(tokenPath(ACCESS_TOKEN_FILE), body.access_token, "utf8");
  await refreshCopilotApiKey(body.access_token);
  // LiteLLM registers github_copilot/* deployments at startup against whatever
  // tokens existed then. If we boot before the user authorises, those
  // deployments are never registered. Restarting after we have valid tokens
  // is the simplest way to get the router into a sane state.
  await restartLitellm();
  await safeUnlink(tokenPath(PENDING_FILE));
  return { status: "authorized" };
}

function restartLitellm(): Promise<void> {
  return new Promise((resolve) => {
    const proc = spawn(
      "supervisorctl",
      ["-c", "/etc/supervisor/supervisord.conf", "restart", "litellm"],
      { stdio: "ignore" },
    );
    // Best-effort: don't block / fail auth if supervisor isn't reachable.
    const done = () => resolve();
    proc.on("close", done);
    proc.on("error", done);
    setTimeout(done, 5000);
  });
}

async function refreshCopilotApiKey(accessToken: string): Promise<void> {
  const res = await fetch(COPILOT_API_KEY_URL, {
    headers: {
      ...editorHeaders,
      authorization: `token ${accessToken}`,
    },
  });
  if (!res.ok) {
    throw new Error(
      `Copilot API key fetch failed: ${res.status} ${await res.text()}`,
    );
  }
  const apiKey = (await res.json()) as CopilotApiKey;
  await writeJson(tokenPath(API_KEY_FILE), apiKey);
}

export type AuthSnapshot = {
  authenticated: boolean;
  api_key_valid: boolean;
  api_key_expires_at: number | null;
  pending_flow: boolean;
};

/** What the dashboard needs to render the auth tile. */
export async function readAuthSnapshot(): Promise<AuthSnapshot> {
  const [accessTokenStat, apiKey, pending] = await Promise.all([
    fs.stat(tokenPath(ACCESS_TOKEN_FILE)).catch(() => null),
    readJson<CopilotApiKey>(tokenPath(API_KEY_FILE)),
    readJson<Pending>(tokenPath(PENDING_FILE)),
  ]);

  const now = Math.floor(Date.now() / 1000);
  const apiKeyValid = !!(apiKey && apiKey.expires_at && apiKey.expires_at > now);

  return {
    authenticated: !!accessTokenStat,
    api_key_valid: apiKeyValid,
    api_key_expires_at: apiKey?.expires_at ?? null,
    pending_flow: !!pending,
  };
}

/** Wipe everything. Used by the /auth Revoke button. */
export async function revokeAll(): Promise<void> {
  await Promise.all([
    safeUnlink(tokenPath(ACCESS_TOKEN_FILE)),
    safeUnlink(tokenPath(API_KEY_FILE)),
    safeUnlink(tokenPath(PENDING_FILE)),
  ]);
}
