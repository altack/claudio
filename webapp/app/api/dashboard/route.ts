// Single bundled endpoint the consolidated dashboard polls. One round trip
// per refresh keeps the wire dead-simple and the perceived latency low.
//
// `?tz=<IANA zone>` decides where day boundaries and hour columns fall. The
// container runs in UTC; the browser sends its own zone so the heatmap lines
// up with the user's clock instead of the container's.

import { NextResponse } from "next/server";
import { health, listModels } from "@/lib/litellm";
import { readAuthSnapshot } from "@/lib/copilot-auth";
import { readPreferences } from "@/lib/preferences";
import { resolvePreferences } from "@/lib/models";
import { readCatalogMeta } from "@/lib/catalog";
import { getUsageSummary } from "@/lib/usage";
import { activeSessionCount } from "@/lib/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const tz = new URL(req.url).searchParams.get("tz");

  const [proxy, auth, stored, usage, catalog, modelsResult] = await Promise.all([
    health(),
    readAuthSnapshot(),
    readPreferences(),
    getUsageSummary(30, tz),
    readCatalogMeta(),
    listModels()
      .then((m) => ({ ok: true as const, models: m }))
      .catch((err: unknown) => ({
        ok: false as const,
        error: err instanceof Error ? err.message : String(err),
      })),
  ]);

  const models = modelsResult.ok ? modelsResult.models : [];

  return NextResponse.json({
    proxy,
    auth,
    preferences: resolvePreferences(stored, models.map((m) => m.alias)),
    usage,
    models,
    models_error: modelsResult.ok ? null : modelsResult.error,
    catalog,
    sessions: { active: activeSessionCount() },
  });
}
