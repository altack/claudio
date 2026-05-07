// Single-page consolidated dashboard.
// Auth-gated: anonymous visitors get bounced to /onboarding; signed-in
// users see status, usage, models, and recent calls in one screen.

import { redirect } from "next/navigation";
import { health, listModels } from "@/lib/litellm";
import { readAuthSnapshot } from "@/lib/copilot-auth";
import { readPreferences } from "@/lib/preferences";
import { getUsageSummary } from "@/lib/usage";
import Dashboard from "./Dashboard";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const auth = await readAuthSnapshot();
  if (!auth.authenticated) {
    redirect("/onboarding");
  }

  const [proxy, prefs, usage, modelsResult] = await Promise.all([
    health(),
    readPreferences(),
    getUsageSummary(),
    listModels()
      .then((m) => ({ ok: true as const, models: m }))
      .catch((err: unknown) => ({
        ok: false as const,
        error: err instanceof Error ? err.message : String(err),
      })),
  ]);

  return (
    <Dashboard
      initial={{
        proxy,
        auth,
        preferences: prefs,
        usage,
        models: modelsResult.ok ? modelsResult.models : [],
        models_error: modelsResult.ok ? null : modelsResult.error,
      }}
    />
  );
}
