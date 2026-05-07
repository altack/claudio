// User preferences persisted across container restarts. Lives on the
// claudio_app named volume (/data/claudio/preferences.json) so it survives
// `compose down` but not `down -v`.
//
// The wrapper script (scripts/claudio.ps1) reads these over HTTP from
// /api/preferences and exports them as ANTHROPIC_DEFAULT_*_MODEL env vars.

import { promises as fs } from "node:fs";
import path from "node:path";

export type Tier = "opus" | "sonnet" | "haiku";

export type Preferences = {
  opus: string;
  sonnet: string;
  haiku: string;
};

export const DEFAULT_PREFERENCES: Preferences = {
  opus: "claude-opus-4-7",
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5",
};

const PREFERENCES_DIR =
  process.env.CLAUDIO_APP_DIR || "/data/claudio";

const PREFERENCES_FILE = path.join(PREFERENCES_DIR, "preferences.json");

export function tierOf(alias: string): Tier | null {
  const a = alias.toLowerCase();
  if (a.includes("opus")) return "opus";
  if (a.includes("sonnet")) return "sonnet";
  if (a.includes("haiku")) return "haiku";
  return null;
}

export async function readPreferences(): Promise<Preferences> {
  try {
    const raw = await fs.readFile(PREFERENCES_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<Preferences>;
    return {
      opus: typeof parsed.opus === "string" ? parsed.opus : DEFAULT_PREFERENCES.opus,
      sonnet:
        typeof parsed.sonnet === "string"
          ? parsed.sonnet
          : DEFAULT_PREFERENCES.sonnet,
      haiku:
        typeof parsed.haiku === "string" ? parsed.haiku : DEFAULT_PREFERENCES.haiku,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ...DEFAULT_PREFERENCES };
    }
    throw err;
  }
}

export async function setDefaultModel(tier: Tier, alias: string): Promise<Preferences> {
  if (!/^[a-z0-9._-]+$/i.test(alias)) {
    throw new Error("Invalid alias format");
  }
  const current = await readPreferences();
  const next: Preferences = { ...current, [tier]: alias };
  await fs.mkdir(PREFERENCES_DIR, { recursive: true });
  await fs.writeFile(PREFERENCES_FILE, JSON.stringify(next, null, 2), "utf8");
  return next;
}
