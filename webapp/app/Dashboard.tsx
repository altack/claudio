"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { ModelMapping, HealthResult } from "@/lib/litellm";
import ChatPanel from "@/components/ChatPanel";
import type { AuthSnapshot } from "@/lib/copilot-auth";
import type { CatalogMeta } from "@/lib/catalog";
// lib/models is deliberately free of node: imports, so the client shares the
// server's tier + version logic instead of keeping a second copy of it.
import { AUTO, tierOf, type ResolvedPreferences, type Tier } from "@/lib/models";
import type { RecentCall, Totals, UsageSummary } from "@/lib/usage";

type DashboardState = {
  proxy: HealthResult;
  auth: AuthSnapshot;
  preferences: ResolvedPreferences;
  usage: UsageSummary;
  models: ModelMapping[];
  models_error: string | null;
  catalog: CatalogMeta;
  sessions: { active: number };
};

const POLL_MS = 5_000;

type Range = "24h" | "7d" | "30d";

const RANGE_LABEL: Record<Range, string> = {
  "24h": "last 24 hours",
  "7d": "last 7 days",
  "30d": "last 30 days",
};

// Drives the relative-time labels ("refresh in N"). useSyncExternalStore
// reads `Date.now()` after hydration without a setState-in-effect cascade,
// and returns 0 on the server so SSR/first-render HTML matches.
function subscribeNowSec(callback: () => void): () => void {
  const id = setInterval(callback, 30_000);
  return () => clearInterval(id);
}
function nowSecSnapshot(): number {
  return Math.floor(Date.now() / 1000);
}
function nowSecServerSnapshot(): number {
  return 0;
}

export default function Dashboard({ initial }: { initial: DashboardState }) {
  const router = useRouter();
  const [state, setState] = useState<DashboardState>(initial);
  const [signingOut, setSigningOut] = useState(false);
  const [refreshingModels, setRefreshingModels] = useState(false);
  const [pendingTier, setPendingTier] = useState<Tier | null>(null);
  const [range, setRange] = useState<Range>("7d");
  const [chatModel, setChatModel] = useState<string | null>(null);
  // Server snapshot returns 0 so SSR and first-render HTML match; the real
  // value flips in post-hydration via useSyncExternalStore.
  const nowSec = useSyncExternalStore(
    subscribeNowSec,
    nowSecSnapshot,
    nowSecServerSnapshot,
  );
  const cancelledRef = useRef(false);

  // Buckets are computed server-side, so the server needs to know which zone
  // to compute them in. It rendered this page in the container's zone (UTC);
  // every fetch from here on carries the browser's.
  const fetchDashboard = useCallback(async (): Promise<DashboardState> => {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
    const r = await fetch(`/api/dashboard?tz=${encodeURIComponent(tz)}`, {
      cache: "no-store",
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()) as DashboardState;
  }, []);

  // Background poll — keep the dashboard fresh without flicker. The first tick
  // is immediate so the UTC-rendered SSR view corrects on mount rather than
  // sitting wrong for a poll interval.
  useEffect(() => {
    cancelledRef.current = false;
    async function tick() {
      try {
        const next = await fetchDashboard();
        if (!cancelledRef.current) setState(next);
      } catch {
        // network blip; keep last-good state
      }
    }
    void tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      cancelledRef.current = true;
      clearInterval(id);
    };
  }, [fetchDashboard]);

  // No optimistic write: "auto" resolves server-side against the live model
  // list, so the server's answer is the only one that can be right.
  const setDefault = useCallback(
    async (tier: Tier, alias: string) => {
      if (state.preferences.stored[tier] === alias) return;
      setPendingTier(tier);
      try {
        const r = await fetch("/api/preferences", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tier, alias }),
        });
        if (!r.ok) {
          const body = (await r.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? `HTTP ${r.status}`);
        }
        const next = (await r.json()) as ResolvedPreferences;
        setState((prev) => ({ ...prev, preferences: next }));
        toast.success(
          alias === AUTO
            ? `/${tier} → auto (${next[tier] || "nothing available"})`
            : `/${tier} → ${alias}`,
        );
      } catch (err) {
        toast.error(
          `failed to set ${tier} default: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        setPendingTier(null);
      }
    },
    [state.preferences.stored],
  );

  // Re-discovery means restarting LiteLLM (litellm-start.sh re-runs the
  // generator on each start), so it's an explicit action, never a timer.
  const refreshModels = useCallback(async () => {
    setRefreshingModels(true);
    try {
      const r = await fetch("/api/models/refresh", { method: "POST" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const next = await fetchDashboard();
      setState(next);
      toast.success(`${next.models.length} aliases from copilot`);
    } catch (err) {
      toast.error(
        `refresh failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setRefreshingModels(false);
    }
  }, [fetchDashboard]);

  const openInClaudio = useCallback(async (alias: string) => {
    const cmd = `claudio --model ${alias}`;
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

  // Group models by tier and dedupe. The generator mints dotted and dashed
  // spellings of each Anthropic alias that resolve to the same Copilot
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
      <header className="mb-12 flex items-center justify-between border-b border-hairline pb-4">
        <div className="flex items-center gap-4">
          <span className="flex items-center gap-2 text-fg">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/claudio-logo.svg"
              alt=""
              aria-hidden
              width={24}
              height={24}
              className="self-center"
            />
            claudio
          </span>
          <span className="flex items-center gap-2 text-muted">
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
          metric={`${formatN(state.usage.last_24h.requests)} req/24h`}
        />
        <ProcessRow
          name="copilot"
          tone={copilotStatus.tone}
          stateLabel={copilotStatus.label}
          address=""
          metric={copilotMetric}
        />
        <ProcessRow
          name="claudio"
          tone={state.sessions.active > 0 ? "ok" : "off"}
          stateLabel={state.sessions.active > 0 ? "running" : "stopped"}
          address=""
          metric={`${state.sessions.active} session${state.sessions.active === 1 ? "" : "s"}`}
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
        <UsageMetrics usage={state.usage} range={range} />
        <UsageHeatmap usage={state.usage} range={range} />
      </Section>

      <Section
        index="03"
        title="models"
        collapsible
        storageKey="models"
        right={
          <span className="flex items-baseline gap-4">
            {state.models_error ? (
              <span className="text-err">!</span>
            ) : (
              <span className="text-muted">
                {state.models.length} aliases ·{" "}
                {state.catalog.fetched_at
                  ? `catalog ${formatRelative(state.catalog.fetched_at, nowSec)}`
                  : "catalog not yet discovered"}
              </span>
            )}
            <button
              type="button"
              onClick={refreshModels}
              disabled={refreshingModels}
              title="re-read Copilot's model catalog (restarts litellm)"
              className="text-muted hover:text-accent underline-offset-4 hover:underline disabled:opacity-50"
            >
              {refreshingModels ? "refreshing…" : "refresh"}
            </button>
          </span>
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
              mode={state.preferences.mode.opus}
              stale={state.preferences.stale.includes("opus")}
              pending={pendingTier === "opus"}
              onSelect={(alias) => setDefault("opus", alias)}
              onChat={(alias) => setChatModel(alias)}
              onOpenInClaudio={openInClaudio}
            />
            <TierGroup
              tier="sonnet"
              entries={modelsByTier.sonnet}
              active={state.preferences.sonnet}
              mode={state.preferences.mode.sonnet}
              stale={state.preferences.stale.includes("sonnet")}
              pending={pendingTier === "sonnet"}
              onSelect={(alias) => setDefault("sonnet", alias)}
              onChat={(alias) => setChatModel(alias)}
              onOpenInClaudio={openInClaudio}
            />
            <TierGroup
              tier="haiku"
              entries={modelsByTier.haiku}
              active={state.preferences.haiku}
              mode={state.preferences.mode.haiku}
              stale={state.preferences.stale.includes("haiku")}
              pending={pendingTier === "haiku"}
              onSelect={(alias) => setDefault("haiku", alias)}
              onChat={(alias) => setChatModel(alias)}
              onOpenInClaudio={openInClaudio}
            />
            {modelsByTier.other.length > 0 && (
              <FallbackList
                aliases={modelsByTier.other.map((m) => m.alias)}
                onChat={(alias) => setChatModel(alias)}
                onOpenInClaudio={openInClaudio}
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
        right={<span className="text-muted">in/out · +cache · ttft</span>}
      >
        {state.usage.recent.length === 0 ? (
          <div className="text-muted">
            no calls recorded yet — run{" "}
            <span className="text-fg">claudio --print &quot;say ok&quot;</span>{" "}
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
  // localStorage is the source of truth for collapsed state. Reading via
  // useSyncExternalStore avoids setState-in-effect: SSR/first render returns
  // `defaultOpen`, then post-hydration it re-snapshots from localStorage.
  const fullKey =
    collapsible && storageKey ? `claudio.section.${storageKey}` : null;

  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!fullKey || typeof window === "undefined") return () => {};
      const eventName = `claudio:section:${fullKey}`;
      const onStorage = (e: StorageEvent) => {
        if (e.key === fullKey) onChange();
      };
      window.addEventListener("storage", onStorage);
      window.addEventListener(eventName, onChange);
      return () => {
        window.removeEventListener("storage", onStorage);
        window.removeEventListener(eventName, onChange);
      };
    },
    [fullKey],
  );

  const getSnapshot = useCallback(() => {
    if (!fullKey || typeof window === "undefined") return defaultOpen;
    try {
      const v = window.localStorage.getItem(fullKey);
      if (v !== null) return v === "1";
    } catch {
      // localStorage can throw in private modes; fall through to default.
    }
    return defaultOpen;
  }, [fullKey, defaultOpen]);

  const getServerSnapshot = useCallback(() => defaultOpen, [defaultOpen]);

  const isOpen = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );

  function toggle() {
    if (!fullKey || typeof window === "undefined") return;
    const next = !isOpen;
    try {
      window.localStorage.setItem(fullKey, next ? "1" : "0");
    } catch {
      // ignore — the dispatched event below still fires, but the snapshot
      // will keep returning the previous value, leaving state unchanged.
    }
    // Native "storage" events only fire across tabs; dispatch a same-tab
    // event so our own subscriber re-reads the snapshot.
    window.dispatchEvent(new Event(`claudio:section:${fullKey}`));
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
  mode,
  stale,
  pending,
  onSelect,
  onChat,
  onOpenInClaudio,
}: {
  tier: Tier;
  entries: ModelMapping[];
  active: string;
  mode: "auto" | "pinned";
  stale: boolean;
  pending: boolean;
  onSelect: (alias: string) => void;
  onChat: (alias: string) => void;
  onOpenInClaudio: (alias: string) => void;
}) {
  if (entries.length === 0) return null;
  const isAuto = mode === "auto";
  return (
    <div>
      <div className="flex items-baseline justify-between mb-1">
        <span className="text-[11px] tracking-[0.14em] text-muted uppercase">
          {tier}
        </span>
        {pending ? (
          <span className="text-[11px] text-muted">saving…</span>
        ) : stale ? (
          <span className="text-[11px] text-warn">
            pinned model no longer served — using {active || "nothing"}
          </span>
        ) : null}
      </div>
      <div>
        {/* Selecting "auto" is what keeps this tier on whatever Copilot ships
            next; the row shows which model that resolves to right now. */}
        <button
          type="button"
          onClick={() => onSelect(AUTO)}
          disabled={pending}
          className="group flex w-full items-baseline gap-3 py-[4px] text-left hover:bg-[#111111] transition-colors disabled:opacity-50"
        >
          <span
            style={{ width: "2ch" }}
            className={`shrink-0 ${isAuto ? "text-accent" : "text-dim"}`}
          >
            {isAuto ? "✓" : ""}
          </span>
          <span className={isAuto ? "text-accent" : "text-muted group-hover:text-fg"}>
            auto
          </span>
          <span className="text-dim text-[12px] truncate">
            latest {tier} — now {active || "nothing available"}
          </span>
        </button>
        {entries.map((m) => (
          <ModelRow
            key={m.alias}
            alias={m.alias}
            isActive={!isAuto && m.alias === active}
            marked={isAuto && m.alias === active}
            disabled={pending}
            onSelect={() => onSelect(m.alias)}
            onChat={() => onChat(m.alias)}
            onOpenInClaudio={() => onOpenInClaudio(m.alias)}
          />
        ))}
      </div>
    </div>
  );
}

function ModelRow({
  alias,
  isActive,
  marked = false,
  disabled,
  onSelect,
  onChat,
  onOpenInClaudio,
  showCheck = true,
}: {
  alias: string;
  isActive: boolean;
  /** What "auto" currently resolves to — shown, but the tick sits on auto. */
  marked?: boolean;
  disabled?: boolean;
  onSelect?: () => void;
  onChat: () => void;
  onOpenInClaudio: () => void;
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
              {isActive ? "✓" : marked ? "·" : ""}
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
        onClick={onOpenInClaudio}
        className="shrink-0 px-2 py-[2px] text-[11px] text-muted opacity-0 group-hover:opacity-100 hover:text-accent focus:opacity-100 focus:text-accent transition-opacity"
        title={`copy: claudio --model ${alias}`}
      >
        ↗ claudio
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

function sumTotals(rows: Totals[]): Totals {
  return rows.reduce<Totals>(
    (acc, r) => ({
      tokens: acc.tokens + r.tokens,
      input: acc.input + r.input,
      output: acc.output + r.output,
      cache_read: acc.cache_read + r.cache_read,
      cache_write: acc.cache_write + r.cache_write,
      requests: acc.requests + r.requests,
    }),
    { tokens: 0, input: 0, output: 0, cache_read: 0, cache_write: 0, requests: 0 },
  );
}

/**
 * Headline usage for the selected range.
 *
 * `tokens` is input + output — context that was actually processed or
 * generated. Prompt-cache reads are reported separately rather than folded in:
 * Claude Code re-sends its whole conversation every turn and serves most of it
 * from cache, so summing raw prompt tokens reads an order of magnitude higher
 * than anything that was really consumed.
 */
function UsageMetrics({ usage, range }: { usage: UsageSummary; range: Range }) {
  const t =
    range === "24h"
      ? usage.last_24h
      : sumTotals(usage.daily.slice(range === "7d" ? -7 : -30));
  const promptTotal = t.input + t.cache_read + t.cache_write;
  const cachePct = promptTotal > 0 ? Math.round((t.cache_read / promptTotal) * 100) : 0;

  return (
    <div className="mb-5">
      <MetricRow
        label="tokens"
        value={formatN(t.tokens)}
        detail={`in ${formatN(t.input)} · out ${formatN(t.output)}`}
        title="new input + generated output. Prompt-cache reads are counted on the next line, not here."
      />
      <MetricRow
        label="cache"
        value={formatN(t.cache_read)}
        detail={
          `read · ${formatN(t.cache_write)} written` +
          (cachePct > 0 ? ` · ${cachePct}% of prompt served from cache` : "")
        }
        title="prompt-cache traffic. Billed at a fraction of fresh input on the Anthropic API; on Copilot it costs you nothing extra."
      />
      <MetricRow
        label="calls"
        value={formatN(t.requests)}
        detail={
          usage.avg_ttft_ms > 0
            ? `${(usage.avg_ttft_ms / 1000).toFixed(1)}s mean ttft (24h)`
            : ""
        }
        title="completions only — count_tokens probes and other non-generation calls are excluded"
      />
      {/* Spelled out because the obvious sanity check is against Claude Code's
          own /usage, which reports a single session - these totals cover every
          call through the proxy in the selected window, including earlier
          claudio runs, the smoke test and the chat panel. */}
      <div className="mt-2 text-[11px] text-dim">
        {RANGE_LABEL[range]} · all traffic through the proxy, not one claude
        session · buckets in {usage.tz}
      </div>
    </div>
  );
}

function MetricRow({
  label,
  value,
  detail,
  title,
}: {
  label: string;
  value: string;
  detail: string;
  title: string;
}) {
  return (
    <div
      className="flex items-baseline gap-6 py-[3px] border-b border-hairline last:border-b-0 cursor-help"
      title={title}
    >
      <span style={{ width: "10ch" }} className="shrink-0 text-muted">
        {label}
      </span>
      <span style={{ width: "9ch" }} className="shrink-0 text-fg tabular-nums">
        {value}
      </span>
      <span className="text-dim truncate min-w-0 flex-1 tabular-nums">{detail}</span>
    </div>
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
  const rows: {
    label: string;
    cells: { tokens: number; requests: number; cache: number }[];
  }[] =
    range === "24h"
      ? [
          {
            label: "last 24h",
            cells: usage.hourly.map((h) => ({
              tokens: h.tokens,
              requests: h.requests,
              cache: h.cache_read + h.cache_write,
            })),
          },
        ]
      : (range === "7d" ? usage.heatmap.slice(-7) : usage.heatmap.slice(-30)).map(
          (d) => ({
            label: d.date.slice(5), // MM-DD
            cells: d.tokens_by_hour.map((tokens, h) => ({
              tokens,
              requests: d.requests_by_hour[h],
              cache: d.cache_by_hour[h],
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
                cache={cell.cache}
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
  cache,
  max,
  hour,
  date,
}: {
  tokens: number;
  requests: number;
  cache: number;
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
    : `${date ? `${date} ` : ""}${hh}:00 — ${formatN(tokens)} tok · ` +
      `${formatN(cache)} cached · ${formatN(requests)} req`;
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
  onOpenInClaudio,
}: {
  aliases: string[];
  onChat: (alias: string) => void;
  onOpenInClaudio: (alias: string) => void;
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
            onOpenInClaudio={() => onOpenInClaudio(alias)}
            showCheck={true}
          />
        ))}
      </div>
      <div className="mt-2 text-[12px] text-dim">
        invoke with{" "}
        <span className="text-muted">claudio --model &lt;alias&gt;</span>
        {" "}or{" "}
        <span className="text-muted">/model &lt;alias&gt;</span>
        {" "}inside Claude Code — these don&apos;t override the tier defaults.
      </div>
    </div>
  );
}

function RecentRow({ call }: { call: RecentCall }) {
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
        // SSR renders in the container's zone; the client renders in the
        // browser's, which is also what the buckets above are anchored to
        // after the first fetch. Both are "correct", just different, so
        // suppress rather than force one.
        suppressHydrationWarning
      >
        {time}
      </span>
      <span className="text-fg truncate min-w-0 flex-1">{call.model}</span>
      <span
        style={{ width: "13ch" }}
        className="shrink-0 text-right text-muted tabular-nums"
        title={`${call.input_tokens} new input · ${call.output_tokens} output · ${call.cache_read_tokens} served from cache`}
      >
        {formatN(call.input_tokens)}/{formatN(call.output_tokens)}
      </span>
      <span
        style={{ width: "8ch" }}
        className="shrink-0 text-right text-dim tabular-nums"
        title="prompt-cache read"
      >
        {call.cache_read_tokens > 0 ? `+${formatN(call.cache_read_tokens)}` : "—"}
      </span>
      <span
        style={{ width: "8ch" }}
        className="shrink-0 text-right text-muted tabular-nums"
        // For a streamed answer the wall clock measures how long the model
        // talked for, which isn't latency. Show time-to-first-token instead.
        title={
          call.stream && call.ttft_ms > 0
            ? `time to first token; full stream took ${call.duration_ms}ms`
            : "round trip"
        }
      >
        {call.stream && call.ttft_ms > 0
          ? `${call.ttft_ms}ms`
          : call.duration_ms > 0
            ? `${call.duration_ms}ms`
            : "—"}
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

function formatRelative(ts: string, nowSec: number): string {
  // nowSec is 0 during SSR / first client render to avoid hydration mismatch;
  // show a stable placeholder until the post-mount tick fills it in.
  if (nowSec === 0) return "—";
  const t = Date.parse(ts);
  if (!Number.isFinite(t)) return "—";
  const diff = nowSec - Math.floor(t / 1000);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86_400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86_400)}d ago`;
}
