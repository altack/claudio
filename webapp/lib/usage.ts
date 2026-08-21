// Read-only aggregates over /data/litellm/spend.jsonl (written by
// litellm/spend_logger.py), rolled up into the shapes the dashboard needs.
//
// Two things worth knowing before changing anything here:
//
// * **Tokens are split, not summed.** A record carries `input_tokens`
//   (genuinely new context), `output_tokens`, and separately
//   `cache_read_tokens` / `cache_write_tokens`. The headline "tokens" figure
//   is input + output. Summing raw prompt_tokens instead — which is what this
//   file used to do — counts every re-sent turn and every prompt-cache read at
//   full weight, which for Claude Code overstates consumption by 10-100x.
//
// * **Buckets are anchored to a caller-supplied IANA zone**, not UTC. The
//   container runs in UTC; the person reading the dashboard doesn't. Day
//   boundaries and hour columns are computed with Intl so DST is handled.

import { open } from "node:fs/promises";

const SPEND_LOG_PATH = process.env.CLAUDIO_SPEND_LOG ?? "/data/litellm/spend.jsonl";

// The dashboard polls every few seconds and the log is append-only, so cap how
// much of it we ever parse. 8 MB is comfortably more than the 30-day window at
// ~200 bytes/record.
const MAX_READ_BYTES = 8 * 1024 * 1024;

export const DEFAULT_TZ = process.env.CLAUDIO_TZ || "UTC";

export type RawCall = {
  id: string;
  ts: string;
  status: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost: number;
  duration_ms: number;
  ttft_ms: number;
  stream: boolean;
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

/** Token counts, always split. `tokens` (= input + output) is the headline. */
export type Tokens = {
  tokens: number;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
};

export type Totals = Tokens & { requests: number };

export type DailyBucket = Totals & {
  date: string; // YYYY-MM-DD in the requested zone
};

export type HourlyBucket = Totals & {
  hour: string;  // YYYY-MM-DDTHH in the requested zone
  label: string; // HH:00
};

export type HeatmapDay = {
  date: string;
  tokens_by_hour: number[];   // 24 entries, input + output
  requests_by_hour: number[];
  cache_by_hour: number[];    // cache_read + cache_write, for the tooltip
};

export type RecentCall = {
  ts: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  status: string;
  duration_ms: number;
  ttft_ms: number;
  stream: boolean;
};

export type UsageSummary = {
  tz: string;
  last_24h: Totals;          // rolling window, not calendar day
  daily: DailyBucket[];      // `days` entries, oldest -> newest, zero-filled
  hourly: HourlyBucket[];    // 24 entries, oldest -> newest, zero-filled
  heatmap: HeatmapDay[];     // one per daily entry, day x hour matrix
  recent: RecentCall[];      // last 10, newest first
  avg_ttft_ms: number;       // mean time-to-first-token over the last 24h
  quota: {
    limit: number | null;     // monthly entitlement (e.g. 300 for Pro)
    remaining: number | null; // absolute requests left (totRem)
    reset_at: number | null;  // unix seconds until reset
    captured_at: string | null; // ISO ts of the call we read it from
    unlimited: boolean;       // -1/-1 plan
  };
};

/* -------------------------------------------------------------------------- */
/*  Timezone helpers                                                          */
/* -------------------------------------------------------------------------- */

/** An IANA zone we can actually format in, else the container default. */
export function safeTimeZone(tz: string | null | undefined): string {
  if (!tz) return DEFAULT_TZ;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return tz;
  } catch {
    return DEFAULT_TZ;
  }
}

type ZonedParts = { date: string; hour: number };

/**
 * Wall-clock date + hour in `tz`. One formatter is built per call to
 * getUsageSummary and reused for every record — constructing an
 * Intl.DateTimeFormat per row is the slow way to do this.
 */
function zonedPartsFactory(tz: string): (t: number) => ZonedParts {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  });
  return (t: number) => {
    const parts = fmt.formatToParts(new Date(t));
    let y = "", m = "", d = "", h = "0";
    for (const p of parts) {
      if (p.type === "year") y = p.value;
      else if (p.type === "month") m = p.value;
      else if (p.type === "day") d = p.value;
      else if (p.type === "hour") h = p.value;
    }
    // en-CA with hour12:false yields "24" for midnight in some ICU versions.
    const hour = Number(h) % 24;
    return { date: `${y}-${m}-${d}`, hour };
  };
}

/* -------------------------------------------------------------------------- */
/*  Reading                                                                   */
/* -------------------------------------------------------------------------- */

function numberOr(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Tail of the spend log, dropping a leading partial line. */
async function readTail(): Promise<string> {
  let handle;
  try {
    handle = await open(SPEND_LOG_PATH, "r");
  } catch {
    return "";
  }
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - MAX_READ_BYTES);
    const length = size - start;
    if (length <= 0) return "";
    const buf = Buffer.allocUnsafe(length);
    await handle.read(buf, 0, length, start);
    const text = buf.toString("utf8");
    if (start === 0) return text;
    const nl = text.indexOf("\n");
    return nl === -1 ? "" : text.slice(nl + 1);
  } catch {
    return "";
  } finally {
    await handle.close().catch(() => {});
  }
}

async function readAllCalls(): Promise<RawCall[]> {
  const raw = await readTail();
  const out: RawCall[] = [];
  // LiteLLM drives both the sync and the async success handler for one call.
  // spend_logger.py already de-dupes in-process, but it only remembers the
  // last few thousand ids and forgets everything on restart, so re-check here.
  const seen = new Set<string>();

  for (const line of raw.split("\n")) {
    if (!line) continue;
    let r: Record<string, unknown>;
    try {
      r = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // partial write at crash, or a pre-v2 line
    }
    if (numberOr(r.v, 0) < 2) continue; // schema v1 counted cache reads as input
    const id = String(r.id ?? "");
    if (id) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    const call: RawCall = {
      id,
      ts: String(r.ts ?? ""),
      status: String(r.status ?? "success"),
      model: String(r.model ?? "unknown"),
      input_tokens: numberOr(r.input_tokens, 0),
      output_tokens: numberOr(r.output_tokens, 0),
      cache_read_tokens: numberOr(r.cache_read_tokens, 0),
      cache_write_tokens: numberOr(r.cache_write_tokens, 0),
      cost: numberOr(r.cost, 0),
      duration_ms: numberOr(r.duration_ms, 0),
      ttft_ms: numberOr(r.ttft_ms, 0),
      stream: r.stream === true,
    };
    if (r.quota && typeof r.quota === "object") {
      call.quota = r.quota as RawQuota;
    }
    out.push(call);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Aggregation                                                               */
/* -------------------------------------------------------------------------- */

function emptyTotals(): Totals {
  return {
    tokens: 0,
    input: 0,
    output: 0,
    cache_read: 0,
    cache_write: 0,
    requests: 0,
  };
}

function accumulate(into: Totals, c: RawCall): void {
  into.input += c.input_tokens;
  into.output += c.output_tokens;
  into.cache_read += c.cache_read_tokens;
  into.cache_write += c.cache_write_tokens;
  into.tokens += c.input_tokens + c.output_tokens;
  into.requests += 1;
}

export async function getUsageSummary(
  days = 30,
  timeZone?: string | null,
): Promise<UsageSummary> {
  const tz = safeTimeZone(timeZone);
  const zoned = zonedPartsFactory(tz);
  const calls = await readAllCalls();
  const now = Date.now();

  const day24Cutoff = now - 24 * 60 * 60 * 1000;

  const last_24h = emptyTotals();
  let ttft_sum = 0;
  let ttft_n = 0;

  // Daily buckets, zero-filled, oldest -> newest. Walking back in 24h steps
  // and re-deriving the zoned date each time keeps DST-shifted days correct.
  const daily: DailyBucket[] = [];
  const dailyMap = new Map<string, DailyBucket>();
  for (let i = days - 1; i >= 0; i--) {
    const date = zoned(now - i * 24 * 60 * 60 * 1000).date;
    if (dailyMap.has(date)) continue;
    const bucket: DailyBucket = { date, ...emptyTotals() };
    daily.push(bucket);
    dailyMap.set(date, bucket);
  }

  // Hourly buckets for the 24h range.
  const hourly: HourlyBucket[] = [];
  const hourlyMap = new Map<string, HourlyBucket>();
  for (let i = 23; i >= 0; i--) {
    const { date, hour } = zoned(now - i * 60 * 60 * 1000);
    const hh = String(hour).padStart(2, "0");
    const key = `${date}T${hh}`;
    if (hourlyMap.has(key)) continue;
    const bucket: HourlyBucket = {
      hour: key,
      label: `${hh}:00`,
      ...emptyTotals(),
    };
    hourly.push(bucket);
    hourlyMap.set(key, bucket);
  }

  // Day x hour matrix, one row per daily bucket.
  const heatmapMap = new Map<string, HeatmapDay>();
  const heatmap: HeatmapDay[] = daily.map((d) => {
    const row: HeatmapDay = {
      date: d.date,
      tokens_by_hour: new Array(24).fill(0),
      requests_by_hour: new Array(24).fill(0),
      cache_by_hour: new Array(24).fill(0),
    };
    heatmapMap.set(d.date, row);
    return row;
  });

  for (const c of calls) {
    const t = Date.parse(c.ts);
    if (!Number.isFinite(t)) continue;
    const { date, hour } = zoned(t);

    if (t >= day24Cutoff) {
      accumulate(last_24h, c);
      if (c.status === "success" && c.ttft_ms > 0) {
        ttft_sum += c.ttft_ms;
        ttft_n += 1;
      }
    }

    const dayBucket = dailyMap.get(date);
    if (dayBucket) accumulate(dayBucket, c);

    const hourBucket = hourlyMap.get(`${date}T${String(hour).padStart(2, "0")}`);
    if (hourBucket) accumulate(hourBucket, c);

    const row = heatmapMap.get(date);
    if (row) {
      row.tokens_by_hour[hour] += c.input_tokens + c.output_tokens;
      row.requests_by_hour[hour] += 1;
      row.cache_by_hour[hour] += c.cache_read_tokens + c.cache_write_tokens;
    }
  }

  // Walk backward to find the most recent call that carried Copilot's
  // x-quota-snapshot-premium_interactions header. Premium interactions is
  // the bucket that gates Claude 4.x/5 and the other paid models — chat/
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
      q.reset_at != null ? Math.floor(Date.parse(q.reset_at) / 1000) : NaN;
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

  const recent: RecentCall[] = calls
    .slice(-30)
    .reverse()
    .slice(0, 10)
    .map((c) => ({
      ts: c.ts,
      model: c.model,
      input_tokens: c.input_tokens,
      output_tokens: c.output_tokens,
      cache_read_tokens: c.cache_read_tokens,
      status: c.status,
      duration_ms: c.duration_ms,
      ttft_ms: c.ttft_ms,
      stream: c.stream,
    }));

  return {
    tz,
    last_24h,
    daily,
    hourly,
    heatmap,
    recent,
    avg_ttft_ms: ttft_n > 0 ? Math.round(ttft_sum / ttft_n) : 0,
    quota,
  };
}
