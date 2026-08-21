// Per-tier default models.
//
// GET returns *resolved* aliases — the wrapper scripts export these straight
// into ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL, so they must be names the
// gateway actually serves, never the "auto" sentinel we store on disk.
//
// `?format=env` returns the same three values as plain `KEY=value` lines. The
// wrappers are PowerShell and POSIX sh with no jq dependency; handing them
// line-oriented text beats making them parse nested JSON with sed.

import { NextResponse } from "next/server";
import { readPreferences, setDefaultModel } from "@/lib/preferences";
import { AUTO, TIERS, resolvePreferences, type Tier } from "@/lib/models";
import { listModels } from "@/lib/litellm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALIAS_RE = /^[a-z0-9._-]+$/i;

const ENV_VAR: Record<Tier, string> = {
  opus: "ANTHROPIC_DEFAULT_OPUS_MODEL",
  sonnet: "ANTHROPIC_DEFAULT_SONNET_MODEL",
  haiku: "ANTHROPIC_DEFAULT_HAIKU_MODEL",
};

export async function GET(req: Request) {
  const stored = await readPreferences();
  let aliases: string[] = [];
  try {
    aliases = (await listModels()).map((m) => m.alias);
  } catch {
    // Gateway down or mid-restart. Resolution falls back to whatever is
    // pinned; "auto" tiers come back empty and the wrapper uses its own cache.
  }
  const resolved = resolvePreferences(stored, aliases);

  if (new URL(req.url).searchParams.get("format") === "env") {
    const body = TIERS.filter((t) => resolved[t])
      .map((t) => `${ENV_VAR[t]}=${resolved[t]}\n`)
      .join("");
    return new NextResponse(body, {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  return NextResponse.json(resolved);
}

export async function PUT(req: Request) {
  let body: { tier?: string; alias?: string };
  try {
    body = (await req.json()) as { tier?: string; alias?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { tier, alias } = body;
  if (!tier || !TIERS.includes(tier as Tier)) {
    return NextResponse.json(
      { error: `tier must be one of ${TIERS.join(", ")}` },
      { status: 400 },
    );
  }
  if (!alias || typeof alias !== "string" || !ALIAS_RE.test(alias)) {
    return NextResponse.json({ error: "alias is required" }, { status: 400 });
  }

  let aliases: string[] = [];
  try {
    aliases = (await listModels()).map((m) => m.alias);
  } catch {
    // If we can't check, accept the write rather than block on a proxy blip.
  }
  if (alias !== AUTO && aliases.length > 0 && !aliases.includes(alias)) {
    return NextResponse.json(
      { error: `gateway does not serve "${alias}"` },
      { status: 400 },
    );
  }

  try {
    const stored = await setDefaultModel(tier as Tier, alias);
    return NextResponse.json(resolvePreferences(stored, aliases));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
