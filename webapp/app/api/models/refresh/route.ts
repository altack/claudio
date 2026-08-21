// Re-discover the Copilot model catalog.
//
// supervisor/litellm-start.sh runs generate_config.py on every proxy start, so
// restarting LiteLLM is the refresh. It drops in-flight requests, which is why
// this is a deliberate user action rather than something on a timer.

import { NextResponse } from "next/server";
import { restartLitellm } from "@/lib/supervisor";
import { readCatalogMeta } from "@/lib/catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  await restartLitellm();
  return NextResponse.json({ ok: true, catalog: await readCatalogMeta() });
}
