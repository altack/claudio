import { NextResponse } from "next/server";
import {
  readPreferences,
  setDefaultModel,
  type Tier,
} from "@/lib/preferences";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_TIERS: Tier[] = ["opus", "sonnet", "haiku"];

export async function GET() {
  const prefs = await readPreferences();
  return NextResponse.json(prefs);
}

export async function PUT(req: Request) {
  let body: { tier?: string; alias?: string };
  try {
    body = (await req.json()) as { tier?: string; alias?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { tier, alias } = body;
  if (!tier || !VALID_TIERS.includes(tier as Tier)) {
    return NextResponse.json(
      { error: `tier must be one of ${VALID_TIERS.join(", ")}` },
      { status: 400 },
    );
  }
  if (!alias || typeof alias !== "string") {
    return NextResponse.json({ error: "alias is required" }, { status: 400 });
  }

  try {
    const next = await setDefaultModel(tier as Tier, alias);
    return NextResponse.json(next);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
