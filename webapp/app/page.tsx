// Single-page consolidated dashboard.
// Auth-gated: anonymous visitors get bounced to /onboarding; signed-in
// users see status, usage, models, and recent calls in one screen.
//
// The server has no idea what timezone the reader is in, so this render uses
// the container default (CLAUDIO_TZ, else UTC). Dashboard re-fetches with the
// browser's own zone the moment it mounts.

import { redirect } from "next/navigation";
import { health, listModels } from "@/lib/litellm";
import { readAuthSnapshot } from "@/lib/copilot-auth";
import { readPreferences } from "@/lib/preferences";
import { resolvePreferences } from "@/lib/models";
import { readCatalogMeta } from "@/lib/catalog";
import { getUsageSummary } from "@/lib/usage";
import { activeSessionCount } from "@/lib/sessions";
import Dashboard from "./Dashboard";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const auth = await readAuthSnapshot();
  if (!auth.authenticated) {
    redirect("/onboarding");
  }

  const [proxy, stored, usage, catalog, modelsResult] = await Promise.all([
    health(),
    readPreferences(),
    getUsageSummary(),
    readCatalogMeta(),
    listModels()
      .then((m) => ({ ok: true as const, models: m }))
      .catch((err: unknown) => ({
        ok: false as const,
        error: err instanceof Error ? err.message : String(err),
      })),
  ]);

  const models = modelsResult.ok ? modelsResult.models : [];

  return (
    <Dashboard
      initial={{
        proxy,
        auth,
        preferences: resolvePreferences(stored, models.map((m) => m.alias)),
        usage,
        models,
        models_error: modelsResult.ok ? null : modelsResult.error,
        catalog,
        sessions: { active: activeSessionCount() },
      }}
    />
  );
}
