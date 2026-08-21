// Pure model-alias helpers: tier detection, version ordering, and resolving
// "auto" tier defaults against whatever the gateway currently serves.
//
// Deliberately free of node: imports so the client bundle can use the same
// logic the server does — Dashboard.tsx used to keep its own copy of tierOf()
// precisely because lib/preferences.ts drags in node:fs.

export type Tier = "opus" | "sonnet" | "haiku";

export const TIERS: Tier[] = ["opus", "sonnet", "haiku"];

/** Sentinel stored in preferences.json meaning "whatever's newest today". */
export const AUTO = "auto";

/** Aliases carrying one of these read as experimental; ranked below plain ones. */
const DEPRIORITISED = ["preview", "beta", "fast", "experimental", "thinking"];

export function tierOf(alias: string): Tier | null {
  const a = alias.toLowerCase();
  if (a.includes("opus")) return "opus";
  if (a.includes("sonnet")) return "sonnet";
  if (a.includes("haiku")) return "haiku";
  return null;
}

export type ModelVersion = {
  parts: number[];   // [4, 8] for 4.8 / 4-8; [5] for 5
  flagged: boolean;  // preview / fast / beta variant
  dashed: boolean;   // dashed spelling (claude-opus-4-8)
};

/**
 * Pull the version out of a Copilot-minted alias.
 *
 * `claude-opus-4.8` and `claude-opus-4-8` are the same model shipped under two
 * spellings (Claude Code's ANTHROPIC_DEFAULT_*_MODEL vars are dash-only), so
 * both must parse to [4, 8] or ordering breaks.
 */
export function parseModelVersion(alias: string): ModelVersion {
  const a = alias.toLowerCase();
  const tier = tierOf(a);
  const tail = tier ? a.slice(a.indexOf(tier) + tier.length) : a;

  const m = /^[-.]?(\d+(?:[.-]\d+)*)/.exec(tail);
  const parts = m ? m[1].split(/[.-]/).map((n) => Number(n)) : [];
  const rest = m ? tail.slice(m[0].length) : tail;

  return {
    parts: parts.every((n) => Number.isFinite(n)) ? parts : [],
    flagged: DEPRIORITISED.some((f) => rest.includes(f)),
    // A dot anywhere in the *version* means the dotted spelling.
    dashed: !(m ? m[1].includes(".") : alias.includes(".")),
  };
}

function compareParts(a: number[], b: number[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (b[i] ?? 0) - (a[i] ?? 0); // descending
    if (d !== 0) return d;
  }
  return 0;
}

/** Newest first. Plain beats preview/fast; dashed beats dotted on a tie. */
export function compareAliases(a: string, b: string): number {
  const va = parseModelVersion(a);
  const vb = parseModelVersion(b);
  const byVersion = compareParts(va.parts, vb.parts);
  if (byVersion !== 0) return byVersion;
  if (va.flagged !== vb.flagged) return va.flagged ? 1 : -1;
  if (va.dashed !== vb.dashed) return va.dashed ? -1 : 1;
  return a.localeCompare(b);
}

/**
 * Highest-versioned alias in a tier, or null when the gateway serves none.
 *
 * Returns the dashed spelling by preference: that's what the wrapper exports
 * as ANTHROPIC_DEFAULT_*_MODEL, and the gateway serves both spellings.
 */
export function pickLatest(aliases: string[], tier: Tier): string | null {
  const inTier = aliases.filter((a) => tierOf(a) === tier);
  if (inTier.length === 0) return null;
  return [...inTier].sort(compareAliases)[0];
}

export type Preferences = Record<Tier, string>;

export type ResolvedPreferences = {
  /** Concrete alias per tier — what the wrapper exports. Empty if unavailable. */
  opus: string;
  sonnet: string;
  haiku: string;
  /** How each tier got its value. */
  mode: Record<Tier, "auto" | "pinned">;
  /** Tiers whose pinned alias the gateway no longer serves. */
  stale: Tier[];
  /** Raw stored values ("auto" or an alias) so the UI can show the choice. */
  stored: Preferences;
};

/**
 * Turn stored preferences into concrete aliases against the live model list.
 *
 * A pin that the gateway has stopped serving (a model GitHub retired, say)
 * silently falls back to the newest in its tier rather than exporting a name
 * that 400s — but it's reported in `stale` so the UI can say so.
 */
export function resolvePreferences(
  stored: Preferences,
  aliases: string[],
): ResolvedPreferences {
  const available = new Set(aliases);
  const out = {
    mode: {} as Record<Tier, "auto" | "pinned">,
    stale: [] as Tier[],
  } as ResolvedPreferences;
  out.stored = { ...stored };

  for (const tier of TIERS) {
    const pin = stored[tier];
    if (pin && pin !== AUTO && available.has(pin)) {
      out[tier] = pin;
      out.mode[tier] = "pinned";
      continue;
    }
    if (pin && pin !== AUTO) out.stale.push(tier);
    out[tier] = pickLatest(aliases, tier) ?? "";
    out.mode[tier] = pin === AUTO || !pin ? "auto" : "pinned";
  }
  return out;
}
