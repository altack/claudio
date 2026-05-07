// Read-only aggregates over /data/litellm/spend.jsonl. Same source the
// existing getSpendByDay() reads from, but rolled up into shapes the
// consolidated dashboard needs (sparkline, recent calls, today/week totals).

import { readFile } from "node:fs/promises";

const SPEND_LOG_PATH = process.env.CLAUDIO_SPEND_LOG ?? "/data/litellm/spend.jsonl";

export type RawCall = {
  ts: string;
  status: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost: number;
  duration_ms: number;
  quota?: RawQuota;
};

// Mirrors the shape spend_logger.py writes:
//   { "premium_interactions": { entitlement, remaining, percent_remaining, reset_at, ... } }
export type RawQuota = {
  premium_interactions?: {
    entitlement?: string;
    percent_remaining?: string;
    remaining?: string;
    overage?: string;
    overage_permitted?: string;
    reset_at?: string;
  };
};

export type DailyBucket = {
  date: string;       // YYYY-MM-DD (UTC)
  tokens: number;
  requests: number;
};

export type HourlyBucket = {
  hour: string;       // YYYY-MM-DDTHH (UTC) — keeps timezone explicit
  label: string;      // HH:00 (UTC)
  tokens: number;
  requests: number;
};

export type HeatmapDay = {
  date: string;        // YYYY-MM-DD
  tokens_by_hour: number[];   // 24 entries (UTC hour 0..23)
  requests_by_hour: number[]; // 24 entries
};

export type RecentCall = {
  ts: string;
  model: string;
  total_tokens: number;
  status: string;
  duration_ms: number;
};

export type UsageSummary = {
  today_tokens: number;
  today_requests: number;
  week_tokens: number;
  week_requests: number;
  spark: string;             // 14-char unicode bar string, oldest -> newest
  daily: DailyBucket[];      // 30 entries, oldest -> newest, zero-filled
  hourly: HourlyBucket[];    // 24 entries, oldest -> newest, zero-filled
  heatmap: HeatmapDay[];     // 30 entries, oldest -> newest, day×hour matrix
  recent: RecentCall[];      // last 10, newest first
  requests_24h: number;      // last rolling 24h, success + failure
  avg_latency_ms: number;    // mean duration_ms over the last 24h (success only)
  quota: {
    limit: number | null;     // monthly entitlement (e.g. 300 for Pro)
    remaining: number | null; // absolute requests left (totRem)
    reset_at: number | null;  // unix seconds until reset
    captured_at: string | null; // ISO ts of the call we read it from
    unlimited: boolean;       // -1/-1 plan
  };
};

const BAR = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

export function sparkline(values: number[]): string {
  if (values.length === 0) return BAR[0];
  const max = Math.max(...values);
  if (max === 0) return BAR[0].repeat(values.length);
  return values
    .map((v) => {
      const idx = Math.min(BAR.length - 1, Math.round((v / max) * (BAR.length - 1)));
      return BAR[idx];
    })
    .join("");
}

async function readAllCalls(): Promise<RawCall[]> {
  let raw: string;
  try {
    raw = await readFile(SPEND_LOG_PATH, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    return [];
  }
  const out: RawCall[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      const r = JSON.parse(line) as Record<string, unknown>;
      const call: RawCall = {
        ts: String(r.ts ?? ""),
        status: String(r.status ?? "success"),
        model: String(r.model ?? "unknown"),
        prompt_tokens: numberOr(r.prompt_tokens, 0),
        completion_tokens: numberOr(r.completion_tokens, 0),
        total_tokens: numberOr(r.total_tokens, 0),
        cost: numberOr(r.cost, 0),
        duration_ms: numberOr(r.duration_ms, 0),
      };
      if (r.quota && typeof r.quota === "object") {
        call.quota = r.quota as RawQuota;
      }
      out.push(call);
    } catch {
      // skip malformed lines
    }
  }
  return out;
}

function numberOr(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function getUsageSummary(days = 30): Promise<UsageSummary> {
  const calls = await readAllCalls();
  const now = Date.now();

  // Today / week totals + 24h aggregates for the processes panel.
  const todayKey = ymd(new Date(now));
  const weekCutoff = now - 7 * 24 * 60 * 60 * 1000;
  const day24Cutoff = now - 24 * 60 * 60 * 1000;
  let today_tokens = 0,
    today_requests = 0,
    week_tokens = 0,
    week_requests = 0,
    requests_24h = 0,
    latency_sum = 0,
    latency_n = 0;
  for (const c of calls) {
    const t = Date.parse(c.ts);
    if (!Number.isFinite(t)) continue;
    if (ymd(new Date(t)) === todayKey) {
      today_tokens += c.total_tokens;
      today_requests += 1;
    }
    if (t >= weekCutoff) {
      week_tokens += c.total_tokens;
      week_requests += 1;
    }
    if (t >= day24Cutoff) {
      requests_24h += 1;
      if (c.status === "success" && c.duration_ms > 0) {
        latency_sum += c.duration_ms;
        latency_n += 1;
      }
    }
  }
  const avg_latency_ms = latency_n > 0 ? Math.round(latency_sum / latency_n) : 0;

  // Daily buckets, zero-filled, oldest -> newest.
  const daily: DailyBucket[] = [];
  const bucketMap = new Map<string, DailyBucket>();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now - i * 24 * 60 * 60 * 1000);
    const key = ymd(d);
    const bucket: DailyBucket = { date: key, tokens: 0, requests: 0 };
    daily.push(bucket);
    bucketMap.set(key, bucket);
  }
  for (const c of calls) {
    const t = Date.parse(c.ts);
    if (!Number.isFinite(t)) continue;
    const key = ymd(new Date(t));
    const bucket = bucketMap.get(key);
    if (bucket) {
      bucket.tokens += c.total_tokens;
      bucket.requests += 1;
    }
  }

  // Sparkline shows the last 14 days regardless of how many we keep around.
  const spark = sparkline(daily.slice(-14).map((d) => d.tokens));

  // Hourly buckets for the 24h chart range. Keys are floor-to-hour UTC
  // timestamps. Format YYYY-MM-DDTHH so timezone is explicit.
  const hourly: HourlyBucket[] = [];
  const hourlyMap = new Map<string, HourlyBucket>();
  for (let i = 23; i >= 0; i--) {
    const d = new Date(now - i * 60 * 60 * 1000);
    const hour = `${ymd(d)}T${String(d.getUTCHours()).padStart(2, "0")}`;
    const label = `${String(d.getUTCHours()).padStart(2, "0")}:00`;
    const bucket: HourlyBucket = { hour, label, tokens: 0, requests: 0 };
    hourly.push(bucket);
    hourlyMap.set(hour, bucket);
  }
  for (const c of calls) {
    const t = Date.parse(c.ts);
    if (!Number.isFinite(t)) continue;
    const d = new Date(t);
    const key = `${ymd(d)}T${String(d.getUTCHours()).padStart(2, "0")}`;
    const bucket = hourlyMap.get(key);
    if (bucket) {
      bucket.tokens += c.total_tokens;
      bucket.requests += 1;
    }
  }

  // Day × hour matrix for the heatmap. One row per day in `daily`, each
  // row carries 24 entries (UTC hour 0..23).
  const heatmapMap = new Map<string, HeatmapDay>();
  const heatmap: HeatmapDay[] = daily.map((d) => {
    const row: HeatmapDay = {
      date: d.date,
      tokens_by_hour: new Array(24).fill(0),
      requests_by_hour: new Array(24).fill(0),
    };
    heatmapMap.set(d.date, row);
    return row;
  });
  for (const c of calls) {
    const t = Date.parse(c.ts);
    if (!Number.isFinite(t)) continue;
    const d = new Date(t);
    const row = heatmapMap.get(ymd(d));
    if (row) {
      const h = d.getUTCHours();
      row.tokens_by_hour[h] += c.total_tokens;
      row.requests_by_hour[h] += 1;
    }
  }

  // Walk backward to find the most recent call that carried Copilot's
  // x-quota-snapshot-premium_interactions header. Premium interactions is
  // the bucket that gates Claude 4.x and the other paid models — chat/
  // completions buckets are unlimited (-1) on most plans.
  let quota: UsageSummary["quota"] = {
    limit: null,
    remaining: null,
    reset_at: null,
    captured_at: null,
    unlimited: false,
  };
  for (let i = calls.length - 1; i >= 0; i--) {
    const q = calls[i].quota?.premium_interactions;
    if (!q) continue;
    const limit = q.entitlement != null ? Number(q.entitlement) : NaN;
    const remaining = q.remaining != null ? Number(q.remaining) : NaN;
    const reset =
      q.reset_at != null
        ? Math.floor(Date.parse(q.reset_at) / 1000)
        : NaN;
    if (
      Number.isFinite(limit) ||
      Number.isFinite(remaining) ||
      Number.isFinite(reset)
    ) {
      // Copilot uses -1 for "unlimited" on either field.
      const isUnlimited = limit === -1 || remaining === -1;
      quota = {
        limit: Number.isFinite(limit) && limit !== -1 ? limit : null,
        remaining:
          Number.isFinite(remaining) && remaining !== -1 ? remaining : null,
        reset_at: Number.isFinite(reset) ? reset : null,
        captured_at: calls[i].ts,
        unlimited: isUnlimited,
      };
      break;
    }
  }

  // Last 10 calls, newest first.
  const recent: RecentCall[] = calls
    .slice(-30)
    .reverse()
    .slice(0, 10)
    .map((c) => ({
      ts: c.ts,
      model: c.model,
      total_tokens: c.total_tokens,
      status: c.status,
      duration_ms: c.duration_ms,
    }));

  return {
    today_tokens,
    today_requests,
    week_tokens,
    week_requests,
    spark,
    daily,
    hourly,
    heatmap,
    recent,
    requests_24h,
    avg_latency_ms,
    quota,
  };
}
