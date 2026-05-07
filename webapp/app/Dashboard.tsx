"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { ModelMapping, HealthResult } from "@/lib/litellm";
import ChatPanel from "@/components/ChatPanel";
import type { AuthSnapshot } from "@/lib/copilot-auth";
import type { Preferences, Tier } from "@/lib/preferences";
import type { UsageSummary } from "@/lib/usage";

// Inlined here (not imported from lib/preferences) so this client bundle
// doesn't drag node:fs in by transitive import.
function tierOf(alias: string): Tier | null {
  const a = alias.toLowerCase();
  if (a.includes("opus")) return "opus";
  if (a.includes("sonnet")) return "sonnet";
  if (a.includes("haiku")) return "haiku";
  return null;
}

type DashboardState = {
  proxy: HealthResult;
  auth: AuthSnapshot;
  preferences: Preferences;
  usage: UsageSummary;
  models: ModelMapping[];
  models_error: string | null;
};

const POLL_MS = 5_000;

type Range = "24h" | "7d" | "30d";

export default function Dashboard({ initial }: { initial: DashboardState }) {
  const router = useRouter();
  const [state, setState] = useState<DashboardState>(initial);
  const [signingOut, setSigningOut] = useState(false);
  const [pendingTier, setPendingTier] = useState<Tier | null>(null);
  const [range, setRange] = useState<Range>("7d");
  const [chatModel, setChatModel] = useState<string | null>(null);
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  const cancelledRef = useRef(false);

  // Tick every 30s — only used to update relative time labels (refresh in N).
  useEffect(() => {
    const id = setInterval(
      () => setNowSec(Math.floor(Date.now() / 1000)),
      30_000,
    );
    return () => clearInterval(id);
  }, []);

  // Background poll — keep the dashboard fresh without flicker.
  useEffect(() => {
    cancelledRef.current = false;
    async function fetchOnce() {
      try {
        const r = await fetch("/api/dashboard", { cache: "no-store" });
        if (!r.ok || cancelledRef.current) return;
        const next = (await r.json()) as DashboardState;
        if (!cancelledRef.current) setState(next);
      } catch {
        // network blip; keep last-good state
      }
    }
    const id = setInterval(fetchOnce, POLL_MS);
    return () => {
      cancelledRef.current = true;
      clearInterval(id);
    };
  }, []);

  const setDefault = useCallback(
    async (tier: Tier, alias: string) => {
      if (state.preferences[tier] === alias) return;
      setPendingTier(tier);
      // optimistic
      setState((prev) => ({
        ...prev,
        preferences: { ...prev.preferences, [tier]: alias },
      }));
      try {
        const r = await fetch("/api/preferences", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tier, alias }),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const next = (await r.json()) as Preferences;
        setState((prev) => ({ ...prev, preferences: next }));
        toast.success(`/${tier} → ${alias}`);
      } catch (err) {
        // rollback
        setState((prev) => ({
          ...prev,
          preferences: { ...prev.preferences, [tier]: state.preferences[tier] },
        }));
        toast.error(
          `failed to set ${tier} default: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        setPendingTier(null);
      }
    },
    [state.preferences],
  );

  const openInClaudex = useCallback(async (alias: string) => {
    const cmd = `claudex --model ${alias}`;
    try {
      await navigator.clipboard.writeText(cmd);
      toast.success("copied — paste in your terminal");
    } catch {
      // Only surface the command on the failure path, so the user can copy it manually.
      toast.message("clipboard blocked — copy manually", {
        description: cmd,
      });
    }
  }, []);

  const signOut = useCallback(async () => {
    setSigningOut(true);
    try {
      const r = await fetch("/api/auth/revoke", { method: "POST" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      router.push("/onboarding");
      router.refresh();
    } catch (err) {
      toast.error(
        `revoke failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      setSigningOut(false);
    }
  }, [router]);

  // Group models by tier and dedupe. config.yaml ships dotted (claude-opus-4.7)
  // and dashed (claude-opus-4-7) aliases that resolve to the same Copilot
  // backend; showing both is noise. Prefer the user's active pick if one
  // matches, else prefer the dashed form (it's what Claude Code's
  // ANTHROPIC_DEFAULT_*_MODEL env vars use natively), else dotted.
  const modelsByTier = useMemo(() => {
    const groups: Record<Tier | "other", ModelMapping[]> = {
      opus: [],
      sonnet: [],
      haiku: [],
      other: [],
    };
    const norm = (a: string) => a.toLowerCase().replace(/\./g, "-");
    const buckets: Record<Tier | "other", Map<string, ModelMapping>> = {
      opus: new Map(),
      sonnet: new Map(),
      haiku: new Map(),
      other: new Map(),
    };
    for (const m of state.models) {
      const t = tierOf(m.alias) ?? "other";
      const key = norm(m.alias);
      const bucket = buckets[t];
      const existing = bucket.get(key);
      if (!existing) {
        bucket.set(key, m);
        continue;
      }
      const active = t !== "other" ? state.preferences[t] : null;
      if (m.alias === active) {
        bucket.set(key, m);
      } else if (existing.alias !== active && !m.alias.includes(".")) {
        bucket.set(key, m);
      }
    }
    for (const t of ["opus", "sonnet", "haiku", "other"] as const) {
      groups[t] = [...buckets[t].values()];
    }
    return groups;
  }, [state.models, state.preferences]);

  const proxyOk = state.proxy.ok;
  const copilotStatus = deriveCopilotStatus(state.auth, state.usage.quota);
  const overallTone: StatusTone = !proxyOk
    ? "err"
    : copilotStatus.tone === "err"
      ? "err"
      : copilotStatus.tone === "off" || copilotStatus.tone === "warn"
        ? "warn"
        : "ok";
  const overallLabel =
    overallTone === "ok"
      ? "ready"
      : overallTone === "warn"
        ? copilotStatus.tone === "warn"
          ? copilotStatus.label
          : "degraded"
        : "down";

  const copilotMetric = buildCopilotMetric(state.auth, state.usage.quota, nowSec);

  return (
    <main className="mx-auto w-full max-w-[920px] px-6 py-10 min-h-screen flex flex-col">
      <header className="mb-12 flex items-baseline justify-between border-b border-hairline pb-4">
        <div className="flex items-baseline gap-4">
          <span className="text-fg">claudex</span>
          <span className="flex items-baseline gap-2 text-muted">
            <StatusDot tone={overallTone} />
            <span
              className={
                overallTone === "ok"
                  ? "text-ok"
                  : overallTone === "warn"
                    ? "text-warn"
                    : "text-err"
              }
            >
              {overallLabel}
            </span>
          </span>
        </div>
        <button
          type="button"
          onClick={signOut}
          disabled={signingOut}
          className="text-muted hover:text-err underline-offset-4 hover:underline disabled:opacity-50"
        >
          {signingOut ? "revoking…" : "sign out"}
        </button>
      </header>

      <Section index="01" title="processes">
        <ProcessRow
          name="litellm"
          tone={proxyOk ? "ok" : "err"}
          stateLabel={proxyOk ? "up" : "down"}
          address={proxyOk ? "127.0.0.1:4000" : state.proxy.detail ?? "unreachable"}
          metric={`${formatN(state.usage.requests_24h)} req/24h`}
        />
        <ProcessRow
          name="webapp"
          tone="ok"
          stateLabel="up"
          address="127.0.0.1:3000"
          metric=""
        />
        <ProcessRow
          name="copilot"
          tone={copilotStatus.tone}
          stateLabel={copilotStatus.label}
          address=""
          metric={copilotMetric}
        />
      </Section>

      <Section
        index="02"
        title="usage"
        collapsible
        storageKey="usage"
        right={
          <span className="flex items-baseline gap-4">
            <HeatmapLegend />
            <RangeToggle value={range} onChange={setRange} />
          </span>
        }
      >
        <UsageHeatmap usage={state.usage} range={range} />
      </Section>

      <Section
        index="03"
        title="models"
        collapsible
        storageKey="models"
        right={
          state.models_error ? (
            <span className="text-err">!</span>
          ) : (
            <span className="text-muted">click to set default · ✓ = active</span>
          )
        }
      >
        {state.models_error ? (
          <div className="text-err">unable to read /v1/models — {state.models_error}</div>
        ) : (
          <div className="space-y-5">
            <TierGroup
              tier="opus"
              entries={modelsByTier.opus}
              active={state.preferences.opus}
              pending={pendingTier === "opus"}
              onSelect={(alias) => setDefault("opus", alias)}
              onChat={(alias) => setChatModel(alias)}
              onOpenInClaudex={openInClaudex}
            />
            <TierGroup
              tier="sonnet"
              entries={modelsByTier.sonnet}
              active={state.preferences.sonnet}
              pending={pendingTier === "sonnet"}
              onSelect={(alias) => setDefault("sonnet", alias)}
              onChat={(alias) => setChatModel(alias)}
              onOpenInClaudex={openInClaudex}
            />
            <TierGroup
              tier="haiku"
              entries={modelsByTier.haiku}
              active={state.preferences.haiku}
              pending={pendingTier === "haiku"}
              onSelect={(alias) => setDefault("haiku", alias)}
              onChat={(alias) => setChatModel(alias)}
              onOpenInClaudex={openInClaudex}
            />
            {modelsByTier.other.length > 0 && (
              <FallbackList
                aliases={modelsByTier.other.map((m) => m.alias)}
                onChat={(alias) => setChatModel(alias)}
                onOpenInClaudex={openInClaudex}
              />
            )}
          </div>
        )}
      </Section>

      <Section
        index="04"
        title="recent"
        collapsible
        storageKey="recent"
        right={<span className="text-muted">last 10 calls</span>}
      >
        {state.usage.recent.length === 0 ? (
          <div className="text-muted">
            no calls recorded yet — run{" "}
            <span className="text-fg">claudex --print &quot;say ok&quot;</span>{" "}
            to generate activity
          </div>
        ) : (
          <div>
            {state.usage.recent.map((c, i) => (
              <RecentRow key={i} call={c} />
            ))}
          </div>
        )}
      </Section>

      <footer className="mt-auto pt-4 flex items-center justify-between border-t border-hairline text-[12px] text-muted">
        <div>Altack © 2026</div>
        <div className="tabular-nums">
          updated {state.usage.recent[0]?.ts ? formatRelative(state.usage.recent[0].ts, nowSec) : "—"}
        </div>
      </footer>

      <ChatPanel model={chatModel} onClose={() => setChatModel(null)} />
    </main>
  );
}

/* -------------------------------------------------------------------------- */
/*  Building blocks                                                           */
/* -------------------------------------------------------------------------- */

type StatusTone = "ok" | "warn" | "err" | "off";

function Section({
  index,
  title,
  right,
  children,
  collapsible = false,
  storageKey,
  defaultOpen = true,
}: {
  index: string;
  title: string;
  right?: React.ReactNode;
  children: React.ReactNode;
  collapsible?: boolean;
  storageKey?: string;
  defaultOpen?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  useEffect(() => {
    if (!collapsible || !storageKey || typeof window === "undefined") return;
    try {
      const v = window.localStorage.getItem(`claudex.section.${storageKey}`);
      if (v !== null) setIsOpen(v === "1");
    } catch {
      // localStorage can throw in private modes; just use the default.
    }
  }, [collapsible, storageKey]);

  function toggle() {
    setIsOpen((prev) => {
      const next = !prev;
      if (collapsible && storageKey && typeof window !== "undefined") {
        try {
          window.localStorage.setItem(
            `claudex.section.${storageKey}`,
            next ? "1" : "0",
          );
        } catch {
          // ignore — state still updates in memory
        }
      }
      return next;
    });
  }

  const titleBlock = (
    <span className="flex items-baseline gap-3 text-[11px] tracking-[0.14em] uppercase">
      <span className="text-dim transition-colors group-hover:text-muted">
        {index}
      </span>
      <span className="text-muted transition-colors group-hover:text-fg">
        {title}
      </span>
      {collapsible && (
        <span
          aria-hidden
          className="text-dim normal-case tracking-normal text-[12px] inline-block transition-all duration-200 group-hover:text-muted"
          style={{
            transform: isOpen ? "rotate(0deg)" : "rotate(-90deg)",
            transformOrigin: "center 60%",
          }}
        >
          ▾
        </span>
      )}
    </span>
  );

  // Right-side content (range toggle, hints) only makes sense when the
  // section is open. Hide it while collapsed so the header reads cleanly.
  const showRight = right && (!collapsible || isOpen);

  return (
    <section className="mb-10">
      <div className="mb-3 flex items-baseline justify-between gap-4">
        {collapsible ? (
          <button
            type="button"
            onClick={toggle}
            className="group"
            aria-expanded={isOpen}
            aria-controls={storageKey ? `section-${storageKey}` : undefined}
          >
            {titleBlock}
          </button>
        ) : (
          titleBlock
        )}
        {showRight ? <div className="text-[12px]">{right}</div> : null}
      </div>
      {collapsible ? (
        // grid-template-rows 0fr ↔ 1fr animates from collapsed to natural
        // height without needing to measure the content. The inner div's
        // overflow hidden keeps content clipped while collapsed.
        <div
          id={storageKey ? `section-${storageKey}` : undefined}
          className="grid transition-[grid-template-rows,opacity] duration-200 ease-out"
          style={{
            gridTemplateRows: isOpen ? "1fr" : "0fr",
            opacity: isOpen ? 1 : 0,
          }}
          aria-hidden={!isOpen}
        >
          <div className="min-h-0 overflow-hidden">{children}</div>
        </div>
      ) : (
        <div>{children}</div>
      )}
    </section>
  );
}

function StatusDot({ tone }: { tone: StatusTone }) {
  const color =
    tone === "ok"
      ? "var(--ok)"
      : tone === "warn"
        ? "var(--warn)"
        : tone === "err"
          ? "var(--err)"
          : "var(--dim)";
  return (
    <span
      aria-hidden
      style={{
        background: color,
        display: "inline-block",
        width: 6,
        height: 6,
      }}
    />
  );
}

function ProcessRow({
  name,
  tone,
  stateLabel,
  address,
  metric,
}: {
  name: string;
  tone: StatusTone;
  stateLabel: string;
  address: string;
  metric: React.ReactNode;
}) {
  const stateColor =
    tone === "ok"
      ? "text-ok"
      : tone === "warn"
        ? "text-warn"
        : tone === "err"
          ? "text-err"
          : "text-muted";
  return (
    <div className="flex items-baseline gap-6 py-[6px] border-b border-hairline last:border-b-0">
      <span style={{ width: "10ch" }} className="shrink-0 text-fg">
        {name}
      </span>
      <span
        style={{ width: "12ch" }}
        className="shrink-0 flex items-baseline gap-2"
      >
        <StatusDot tone={tone} />
        <span className={stateColor}>{stateLabel}</span>
      </span>
      <span className="text-muted truncate min-w-0 flex-1">{address}</span>
      <span className="shrink-0 text-muted tabular-nums">{metric}</span>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="whitespace-nowrap">
      <div className="text-[11px] tracking-[0.14em] text-muted uppercase">
        {label}
      </div>
      <div className="mt-1 text-fg tabular-nums text-[16px]">{value}</div>
    </div>
  );
}

// Quota threshold (% remaining of monthly entitlement) below which we flip
// the copilot status to "low quota". 0% trips "quota out".
const QUOTA_LOW_PCT = 10;

function deriveCopilotStatus(
  auth: AuthSnapshot,
  quota: UsageSummary["quota"],
): { tone: StatusTone; label: string } {
  if (!auth.authenticated) return { tone: "off", label: "signed out" };

  // If we have a real entitlement, quota signal beats API-key state, since
  // an expired API key auto-refreshes on the next call but a depleted quota
  // is the wall the user actually cares about.
  if (
    !quota.unlimited &&
    quota.limit != null &&
    quota.remaining != null &&
    quota.limit > 0
  ) {
    const pct = (quota.remaining / quota.limit) * 100;
    if (pct <= 0) return { tone: "err", label: "quota out" };
    if (pct < QUOTA_LOW_PCT) return { tone: "warn", label: "low quota" };
  }

  // Below the quota concerns: API-key freshness. Still useful for the rare
  // case the proxy can't refresh (e.g. revoked GitHub OAuth).
  if (!auth.api_key_valid) return { tone: "warn", label: "expired" };

  return { tone: "ok", label: "valid" };
}

function buildCopilotMetric(
  auth: AuthSnapshot,
  quota: UsageSummary["quota"],
  nowSec: number,
): React.ReactNode {
  if (!auth.authenticated) return "";
  const resetTooltip =
    quota.reset_at != null && quota.reset_at > nowSec
      ? `resets in ${formatDuration(quota.reset_at - nowSec)}`
      : undefined;
  if (quota.unlimited) {
    return (
      <span
        title={resetTooltip}
        className={resetTooltip ? "decoration-dim decoration-dotted underline-offset-4 cursor-help" : ""}
        style={resetTooltip ? { textDecorationLine: "underline", textDecorationStyle: "dotted" } : undefined}
      >
        unlimited on plan
      </span>
    );
  }
  if (quota.limit != null && quota.remaining != null) {
    const used = Math.max(0, quota.limit - Math.floor(quota.remaining));
    const text = `${formatN(used)}/${formatN(quota.limit)} used`;
    return (
      <span
        title={resetTooltip}
        className={resetTooltip ? "cursor-help" : ""}
        style={
          resetTooltip
            ? {
                textDecorationLine: "underline",
                textDecorationStyle: "dotted",
                textDecorationColor: "var(--dim)",
                textUnderlineOffset: "4px",
              }
            : undefined
        }
      >
        {text}
      </span>
    );
  }
  return auth.api_key_valid ? "no usage data yet" : "";
}

function TierGroup({
  tier,
  entries,
  active,
  pending,
  onSelect,
  onChat,
  onOpenInClaudex,
}: {
  tier: Tier;
  entries: ModelMapping[];
  active: string;
  pending: boolean;
  onSelect: (alias: string) => void;
  onChat: (alias: string) => void;
  onOpenInClaudex: (alias: string) => void;
}) {
  if (entries.length === 0) return null;
  return (
    <div>
      <div className="flex items-baseline justify-between mb-1">
        <span className="text-[11px] tracking-[0.14em] text-muted uppercase">
          {tier}
        </span>
        {pending && (
          <span className="text-[11px] text-muted">saving…</span>
        )}
      </div>
      <div>
        {entries.map((m) => (
          <ModelRow
            key={m.alias}
            alias={m.alias}
            isActive={m.alias === active}
            disabled={pending}
            onSelect={() => onSelect(m.alias)}
            onChat={() => onChat(m.alias)}
            onOpenInClaudex={() => onOpenInClaudex(m.alias)}
          />
        ))}
      </div>
    </div>
  );
}

function ModelRow({
  alias,
  isActive,
  disabled,
  onSelect,
  onChat,
  onOpenInClaudex,
  showCheck = true,
}: {
  alias: string;
  isActive: boolean;
  disabled?: boolean;
  onSelect?: () => void;
  onChat: () => void;
  onOpenInClaudex: () => void;
  showCheck?: boolean;
}) {
  return (
    <div className="group flex items-baseline gap-3 py-[4px] hover:bg-[#111111] transition-colors">
      {onSelect ? (
        <button
          type="button"
          onClick={onSelect}
          disabled={disabled}
          className="flex items-baseline gap-3 flex-1 min-w-0 text-left disabled:opacity-50"
        >
          {showCheck && (
            <span
              style={{ width: "2ch" }}
              className={`shrink-0 ${isActive ? "text-accent" : "text-dim"}`}
            >
              {isActive ? "✓" : ""}
            </span>
          )}
          <span
            className={
              isActive
                ? "text-accent truncate"
                : "text-muted group-hover:text-fg truncate"
            }
          >
            {alias}
          </span>
        </button>
      ) : (
        <div className="flex items-baseline gap-3 flex-1 min-w-0">
          {showCheck && <span style={{ width: "2ch" }} className="shrink-0" />}
          <span className="text-fg truncate">{alias}</span>
        </div>
      )}
      <button
        type="button"
        onClick={onChat}
        className="shrink-0 px-2 py-[2px] text-[11px] text-muted opacity-0 group-hover:opacity-100 hover:text-accent focus:opacity-100 focus:text-accent transition-opacity"
        title={`diagnostic chat — talks directly to ${alias} via LiteLLM`}
      >
        chat ▸
      </button>
      <button
        type="button"
        onClick={onOpenInClaudex}
        className="shrink-0 px-2 py-[2px] text-[11px] text-muted opacity-0 group-hover:opacity-100 hover:text-accent focus:opacity-100 focus:text-accent transition-opacity"
        title={`copy: claudex --model ${alias}`}
      >
        ↗ claudex
      </button>
    </div>
  );
}

function HeatmapLegend() {
  // Five-step opacity ramp matches the cell rendering below.
  const stops = [0.18, 0.36, 0.54, 0.72, 1.0];
  return (
    <span className="flex items-baseline gap-2 text-[11px] text-muted">
      <span>less</span>
      <span className="flex gap-[2px]">
        {stops.map((o) => (
          <span
            key={o}
            aria-hidden
            style={{
              background: `rgba(251, 191, 36, ${o})`,
              display: "inline-block",
              width: 10,
              height: 8,
            }}
          />
        ))}
      </span>
      <span>more</span>
    </span>
  );
}

function RangeToggle({
  value,
  onChange,
}: {
  value: Range;
  onChange: (r: Range) => void;
}) {
  const opts: Range[] = ["24h", "7d", "30d"];
  return (
    <span className="flex gap-1">
      {opts.map((r) => (
        <button
          key={r}
          type="button"
          onClick={() => onChange(r)}
          className={
            "px-2 py-[1px] border " +
            (r === value
              ? "border-accent text-accent"
              : "border-hairline text-muted hover:text-fg hover:border-hairline-strong")
          }
        >
          {r}
        </button>
      ))}
    </span>
  );
}

function UsageHeatmap({
  usage,
  range,
}: {
  usage: UsageSummary;
  range: Range;
}) {
  // Pick rows. For 24h we synthesize a single-day view from `hourly` so the
  // user still gets a valid heatmap without a special case downstream.
  const rows: { label: string; cells: { tokens: number; requests: number }[] }[] =
    range === "24h"
      ? [
          {
            label: "last 24h",
            cells: usage.hourly.map((h) => ({
              tokens: h.tokens,
              requests: h.requests,
            })),
          },
        ]
      : (range === "7d" ? usage.heatmap.slice(-7) : usage.heatmap.slice(-30)).map(
          (d) => ({
            label: d.date.slice(5), // MM-DD
            cells: d.tokens_by_hour.map((tokens, h) => ({
              tokens,
              requests: d.requests_by_hour[h],
            })),
          }),
        );

  // Max for normalization. Tokens drives intensity; if everything is zero we
  // render an empty matrix.
  const max = rows.reduce(
    (m, row) => row.cells.reduce((mm, c) => Math.max(mm, c.tokens), m),
    0,
  );

  return (
    <div className="space-y-1">
      <HeatmapHourAxis />
      {rows.map((row, ri) => (
        <div key={ri} className="flex items-center gap-2">
          <span
            style={{ width: "6ch" }}
            className="shrink-0 text-[11px] text-muted tabular-nums"
          >
            {row.label}
          </span>
          <div
            className="flex-1 grid gap-[1px]"
            style={{ gridTemplateColumns: "repeat(24, minmax(0, 1fr))" }}
          >
            {row.cells.map((cell, h) => (
              <HeatmapCell
                key={h}
                tokens={cell.tokens}
                requests={cell.requests}
                max={max}
                hour={h}
                date={range === "24h" ? "" : row.label}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function HeatmapHourAxis() {
  return (
    <div className="flex items-center gap-2 mb-1">
      <span style={{ width: "6ch" }} className="shrink-0" />
      <div
        className="flex-1 grid text-[10px] text-dim tabular-nums"
        style={{ gridTemplateColumns: "repeat(24, minmax(0, 1fr))" }}
      >
        {Array.from({ length: 24 }, (_, h) => (
          <span key={h} className="text-left">
            {h % 6 === 0 ? `${String(h).padStart(2, "0")}` : ""}
          </span>
        ))}
      </div>
    </div>
  );
}

function HeatmapCell({
  tokens,
  requests,
  max,
  hour,
  date,
}: {
  tokens: number;
  requests: number;
  max: number;
  hour: number;
  date: string;
}) {
  // Floor at 0.18 for any non-zero value so even tiny activity reads as
  // "something happened here" against the empty cells.
  const intensity = max > 0 ? tokens / max : 0;
  const opacity = tokens === 0 ? 0 : 0.18 + 0.82 * intensity;
  const bg =
    tokens === 0 ? "var(--hairline)" : `rgba(251, 191, 36, ${opacity})`;
  const hh = String(hour).padStart(2, "0");
  const tooltip = tokens === 0
    ? `${date ? `${date} ` : ""}${hh}:00 — no activity`
    : `${date ? `${date} ` : ""}${hh}:00 — ${formatN(tokens)} tok · ${formatN(requests)} req`;
  return (
    <div
      title={tooltip}
      className="h-[14px] cursor-help"
      style={{ background: bg }}
    />
  );
}

function FallbackList({
  aliases,
  onChat,
  onOpenInClaudex,
}: {
  aliases: string[];
  onChat: (alias: string) => void;
  onOpenInClaudex: (alias: string) => void;
}) {
  return (
    <div className="pt-3 border-t border-hairline">
      <div className="text-[11px] tracking-[0.14em] text-muted uppercase mb-1">
        fallbacks
      </div>
      <div>
        {aliases.map((alias) => (
          <ModelRow
            key={alias}
            alias={alias}
            isActive={false}
            onChat={() => onChat(alias)}
            onOpenInClaudex={() => onOpenInClaudex(alias)}
            showCheck={true}
          />
        ))}
      </div>
      <div className="mt-2 text-[12px] text-dim">
        invoke with{" "}
        <span className="text-muted">claudex --model &lt;alias&gt;</span>
        {" "}or{" "}
        <span className="text-muted">/model &lt;alias&gt;</span>
        {" "}inside Claude Code — these don&apos;t override the tier defaults.
      </div>
    </div>
  );
}

function RecentRow({ call }: { call: { ts: string; model: string; total_tokens: number; status: string; duration_ms: number } }) {
  const t = new Date(call.ts);
  const time = isNaN(t.getTime())
    ? "—"
    : t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  const ok = call.status === "success";
  return (
    <div className="flex items-baseline gap-6 py-[3px] border-b border-hairline last:border-b-0">
      <span
        style={{ width: "10ch" }}
        className="shrink-0 text-muted tabular-nums"
      >
        {time}
      </span>
      <span className="text-fg truncate min-w-0 flex-1">{call.model}</span>
      <span
        style={{ width: "10ch" }}
        className="shrink-0 text-right text-muted tabular-nums"
      >
        {formatN(call.total_tokens)} tok
      </span>
      <span
        style={{ width: "8ch" }}
        className="shrink-0 text-right text-muted tabular-nums"
      >
        {call.duration_ms > 0 ? `${call.duration_ms}ms` : "—"}
      </span>
      <span
        style={{ width: "4ch" }}
        className={`shrink-0 text-right ${ok ? "text-ok" : "text-err"}`}
      >
        {ok ? "ok" : "err"}
      </span>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Formatters                                                                */
/* -------------------------------------------------------------------------- */

function formatN(n: number): string {
  if (n < 1_000) return n.toString();
  if (n < 1_000_000) return `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}M`;
}

function formatDuration(s: number): string {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

function formatLatency(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatRelative(ts: string, nowSec: number): string {
  const t = Date.parse(ts);
  if (!Number.isFinite(t)) return "—";
  const diff = nowSec - Math.floor(t / 1000);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86_400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86_400)}d ago`;
}
