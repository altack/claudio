// Single bundled endpoint the consolidated dashboard polls. One round trip
// per refresh keeps the wire dead-simple and the perceived latency low.

import { NextResponse } from "next/server";
import { health, listModels } from "@/lib/litellm";
import { readAuthSnapshot } from "@/lib/copilot-auth";
import { readPreferences } from "@/lib/preferences";
import { getUsageSummary } from "@/lib/usage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const [proxy, auth, prefs, usage, modelsResult] = await Promise.all([
    health(),
    readAuthSnapshot(),
    readPreferences(),
    getUsageSummary(),
    listModels()
      .then((m) => ({ ok: true as const, models: m }))
      .catch((err: unknown) => ({
        ok: false as const,
        error: err instanceof Error ? err.message : String(err),
      })),
  ]);

  return NextResponse.json({
    proxy,
    auth,
    preferences: prefs,
    usage,
    models: modelsResult.ok ? modelsResult.models : [],
    models_error: modelsResult.ok ? null : modelsResult.error,
  });
}
