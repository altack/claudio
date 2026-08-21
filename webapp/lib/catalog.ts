// Freshness of the Copilot model catalog.
//
// litellm/generate_config.py writes /data/litellm/models.cache.json every time
// it successfully reaches Copilot's /models endpoint. The proxy only
// re-discovers on restart, so the dashboard shows how old the current list is
// and offers a refresh rather than restarting LiteLLM under a live session.

import { readFile } from "node:fs/promises";

const CACHE_PATH =
  process.env.CLAUDIO_MODEL_CACHE ?? "/data/litellm/models.cache.json";

export type CatalogMeta = {
  fetched_at: string | null; // ISO 8601, or null if we've never reached Copilot
  count: number;
};

export async function readCatalogMeta(): Promise<CatalogMeta> {
  try {
    const parsed = JSON.parse(await readFile(CACHE_PATH, "utf8")) as {
      fetched_at?: unknown;
      data?: unknown;
    };
    return {
      fetched_at:
        typeof parsed.fetched_at === "string" ? parsed.fetched_at : null,
      count: Array.isArray(parsed.data) ? parsed.data.length : 0,
    };
  } catch {
    return { fetched_at: null, count: 0 };
  }
}
