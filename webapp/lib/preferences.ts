// User preferences persisted across container restarts. Lives on the
// claudio_app named volume (/data/claudio/preferences.json) so it survives
// `compose down` but not `down -v`.
//
// Each tier holds either the literal "auto" — resolve to whatever the gateway
// currently serves as newest in that family — or a pinned alias. "auto" is the
// default so a new Copilot model (Opus 5, Sonnet 5, …) becomes the tier
// default the moment the catalog picks it up, with no edit anywhere.
//
// The wrapper scripts (scripts/claudio.ps1 / claudio.sh) read the *resolved*
// values over HTTP from /api/preferences and export them as
// ANTHROPIC_DEFAULT_*_MODEL.

import { promises as fs } from "node:fs";
import path from "node:path";
import { AUTO, TIERS, type Preferences, type Tier } from "./models";

export {
  AUTO,
  TIERS,
  tierOf,
  pickLatest,
  resolvePreferences,
  type Preferences,
  type ResolvedPreferences,
  type Tier,
} from "./models";

export const DEFAULT_PREFERENCES: Preferences = {
  opus: AUTO,
  sonnet: AUTO,
  haiku: AUTO,
};

const PREFERENCES_DIR = process.env.CLAUDIO_APP_DIR || "/data/claudio";

const PREFERENCES_FILE = path.join(PREFERENCES_DIR, "preferences.json");

// "auto" or a model alias. Same character class the LiteLLM generator allows.
const ALIAS_RE = /^[a-z0-9._-]+$/i;

export async function readPreferences(): Promise<Preferences> {
  let parsed: Partial<Preferences>;
  try {
    parsed = JSON.parse(await fs.readFile(PREFERENCES_FILE, "utf8")) as Partial<Preferences>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ...DEFAULT_PREFERENCES };
    }
    throw err;
  }
  const out = { ...DEFAULT_PREFERENCES };
  for (const tier of TIERS) {
    const v = parsed[tier];
    if (typeof v === "string" && ALIAS_RE.test(v)) out[tier] = v;
  }
  return out;
}

export async function setDefaultModel(
  tier: Tier,
  alias: string,
): Promise<Preferences> {
  if (!ALIAS_RE.test(alias)) {
    throw new Error("Invalid alias format");
  }
  const current = await readPreferences();
  const next: Preferences = { ...current, [tier]: alias };
  await fs.mkdir(PREFERENCES_DIR, { recursive: true });
  await fs.writeFile(PREFERENCES_FILE, JSON.stringify(next, null, 2), "utf8");
  return next;
}
