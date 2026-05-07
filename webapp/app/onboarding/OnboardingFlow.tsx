"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

type DeviceCode = {
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
};

type PollStatus =
  | "idle"
  | "starting"
  | "pending"
  | "authorized"
  | "expired"
  | "denied"
  | "error";

const POPUP_FEATURES =
  "popup=yes,width=560,height=720,left=80,top=80,resizable=yes,scrollbars=yes";

export default function OnboardingFlow() {
  const router = useRouter();
  const [deviceCode, setDeviceCode] = useState<DeviceCode | null>(null);
  const [status, setStatus] = useState<PollStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const pollerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const popupRef = useRef<Window | null>(null);
  const tickerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollerRef.current) {
      clearInterval(pollerRef.current);
      pollerRef.current = null;
    }
    if (tickerRef.current) {
      clearInterval(tickerRef.current);
      tickerRef.current = null;
    }
  }, []);

  useEffect(() => () => stopPolling(), [stopPolling]);

  const copyCode = useCallback(async (code: string, silent = false) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      if (!silent) toast.success("code copied");
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      if (!silent) toast.message("clipboard blocked — copy it manually");
    }
  }, []);

  const openGitHubPopup = useCallback((code: DeviceCode) => {
    // Try popup first; fall back to a new tab if the browser blocks it.
    const popup = window.open(code.verification_uri, "claudex-github-auth", POPUP_FEATURES);
    if (popup) {
      popupRef.current = popup;
      popup.focus?.();
    } else {
      window.open(code.verification_uri, "_blank", "noopener,noreferrer");
    }
  }, []);

  const startLogin = useCallback(async () => {
    setError(null);
    setStatus("starting");
    setCopied(false);

    try {
      const res = await fetch("/api/auth/login", { method: "POST" });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
      const code = (await res.json()) as DeviceCode;
      setDeviceCode(code);
      setSecondsLeft(code.expires_in);
      setStatus("pending");

      // Clipboard write + popup must run in this same user-gesture turn,
      // or browsers will refuse them.
      void copyCode(code.user_code, true);
      openGitHubPopup(code);

      stopPolling();
      tickerRef.current = setInterval(() => {
        setSecondsLeft((s) => (s != null && s > 0 ? s - 1 : 0));
      }, 1000);

      pollerRef.current = setInterval(async () => {
        try {
          const r = await fetch("/api/auth/login-status", { method: "POST" });
          const body = (await r.json()) as { status?: PollStatus; error?: string };
          if (!r.ok || body.error) {
            throw new Error(body.error ?? `HTTP ${r.status}`);
          }
          if (!body.status) throw new Error("server response missing 'status'");
          if (body.status === "pending") return;

          if (body.status === "authorized") {
            stopPolling();
            popupRef.current?.close?.();
            setStatus("authorized");
            toast.success("signed in");
            window.setTimeout(() => router.push("/"), 900);
            return;
          }
          stopPolling();
          setDeviceCode(null);
          setStatus(body.status as PollStatus);
        } catch (err) {
          stopPolling();
          setStatus("error");
          setError(err instanceof Error ? err.message : String(err));
        }
      }, Math.max(2, code.interval) * 1000);
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [copyCode, openGitHubPopup, router, stopPolling]);

  const reset = useCallback(() => {
    stopPolling();
    setDeviceCode(null);
    setStatus("idle");
    setError(null);
    setCopied(false);
    setSecondsLeft(null);
  }, [stopPolling]);

  const isWaiting = status === "pending" || status === "starting";

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-[640px] flex-col px-6 py-10">
      <header className="mb-12 flex items-baseline justify-between border-b border-hairline pb-4">
        <div className="flex items-baseline gap-3">
          <span className="text-fg">claudex</span>
          <span className="text-muted">/</span>
          <span className="text-muted">authorize</span>
        </div>
        <div className="text-[12px] text-muted">127.0.0.1 · local</div>
      </header>

      <div className="flex-1">
        {status === "authorized" ? (
          <SuccessState />
        ) : deviceCode ? (
          <DeviceCodeState
            code={deviceCode}
            pollStatus={status}
            copied={copied}
            secondsLeft={secondsLeft}
            onCopy={() => copyCode(deviceCode.user_code)}
            onReopenGitHub={() => openGitHubPopup(deviceCode)}
            onCancel={reset}
          />
        ) : status === "expired" ||
          status === "denied" ||
          status === "error" ? (
          <TerminalState
            status={status}
            error={error}
            onRetry={() => {
              reset();
              void startLogin();
            }}
          />
        ) : (
          <IntroState onStart={startLogin} starting={isWaiting} />
        )}
      </div>

      <footer className="mt-12 border-t border-hairline pt-4 text-[12px] text-muted">
        tokens stored in the local{" "}
        <span className="text-fg">claudex_copilot</span> volume — nothing leaves
        this machine
      </footer>
    </main>
  );
}

/* -------------------------------------------------------------------------- */
/*  States                                                                    */
/* -------------------------------------------------------------------------- */

function IntroState({
  onStart,
  starting,
}: {
  onStart: () => void;
  starting: boolean;
}) {
  return (
    <div className="space-y-10">
      <div className="space-y-3">
        <div className="text-[11px] tracking-[0.14em] text-muted uppercase">
          first run
        </div>
        <p className="text-fg leading-relaxed">
          sign in with your github copilot subscription to start routing claude
          code through it. we&apos;ll open a small github window so you can
          authorize, and detect the result automatically — your code will
          already be on your clipboard.
        </p>
      </div>

      <ul className="space-y-2 text-muted">
        <li>
          <span className="text-ok">●</span>{" "}
          <span className="text-fg">use claude</span> on anthropic&apos;s
          models, paid via your copilot plan
        </li>
        <li>
          <span className="text-ok">●</span>{" "}
          <span className="text-fg">tokens stay local</span>, only this machine
          has access
        </li>
        <li>
          <span className="text-ok">●</span>{" "}
          <span className="text-fg">no claudex account</span> — your github
          identity is the only gate
        </li>
      </ul>

      <button
        type="button"
        onClick={onStart}
        disabled={starting}
        className="block w-full border border-accent px-4 py-3 text-left text-accent hover:bg-accent hover:text-bg disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {starting ? "starting…" : "▸ sign in with github copilot"}
      </button>
    </div>
  );
}

function DeviceCodeState({
  code,
  pollStatus,
  copied,
  secondsLeft,
  onCopy,
  onReopenGitHub,
  onCancel,
}: {
  code: DeviceCode;
  pollStatus: PollStatus;
  copied: boolean;
  secondsLeft: number | null;
  onCopy: () => void;
  onReopenGitHub: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="space-y-10">
      <div className="space-y-3">
        <div className="text-[11px] tracking-[0.14em] text-muted uppercase">
          paste this code in the github window
        </div>
        <p className="text-muted leading-relaxed">
          we&apos;ve copied the code and opened a github popup. paste, approve,
          come back — this screen updates automatically.
        </p>
      </div>

      <button
        type="button"
        onClick={onCopy}
        className="block w-full border border-hairline-strong px-6 py-8 text-center hover:bg-[#101010] transition-colors"
      >
        <div className="font-mono text-[28px] tracking-[0.4em] text-fg">
          {code.user_code}
        </div>
        <div className="mt-3 text-[11px] text-muted tracking-[0.08em] uppercase">
          {copied ? "● copied" : "click to copy"}
        </div>
      </button>

      <div className="flex items-baseline justify-between border-t border-hairline pt-4 text-[12px]">
        <button
          type="button"
          onClick={onReopenGitHub}
          className="text-muted hover:text-fg underline-offset-4 hover:underline"
        >
          reopen github
        </button>
        <PollIndicator
          status={pollStatus}
          intervalSec={code.interval}
          secondsLeft={secondsLeft}
        />
      </div>

      <div className="text-right">
        <button
          type="button"
          onClick={onCancel}
          className="text-[12px] text-muted hover:text-err underline-offset-4 hover:underline"
        >
          cancel
        </button>
      </div>
    </div>
  );
}

function PollIndicator({
  status,
  intervalSec,
  secondsLeft,
}: {
  status: PollStatus;
  intervalSec: number;
  secondsLeft: number | null;
}) {
  return (
    <div className="text-muted">
      <span
        aria-hidden
        style={{
          background: status === "pending" ? "var(--accent)" : "var(--dim)",
          display: "inline-block",
          width: 6,
          height: 6,
          marginRight: 8,
        }}
        className={status === "pending" ? "animate-pulse" : ""}
      />
      polling every {intervalSec}s
      {secondsLeft != null && secondsLeft > 0 ? (
        <>
          {" "}· expires in{" "}
          <span className="text-fg tabular-nums">
            {formatCountdown(secondsLeft)}
          </span>
        </>
      ) : null}
    </div>
  );
}

function formatCountdown(s: number): string {
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m === 0) return `${r}s`;
  return `${m}m ${r.toString().padStart(2, "0")}s`;
}

function TerminalState({
  status,
  error,
  onRetry,
}: {
  status: PollStatus;
  error: string | null;
  onRetry: () => void;
}) {
  const message =
    status === "expired"
      ? "device code expired before authorization completed"
      : status === "denied"
        ? "authorization denied on github"
        : "something went wrong talking to github";
  return (
    <div className="space-y-10">
      <div className="space-y-3">
        <div className="text-err">
          <span aria-hidden style={{ background: "var(--err)", display: "inline-block", width: 6, height: 6, marginRight: 8 }} />
          {status}
        </div>
        <p className="text-muted">{message}</p>
        {error ? (
          <pre className="mt-2 whitespace-pre-wrap border border-hairline p-3 text-[12px] text-err">
            {error}
          </pre>
        ) : null}
      </div>
      <button
        type="button"
        onClick={onRetry}
        className="block w-full border border-accent px-4 py-3 text-left text-accent hover:bg-accent hover:text-bg transition-colors"
      >
        ▸ retry
      </button>
    </div>
  );
}

function SuccessState() {
  return (
    <div className="space-y-10">
      <div className="space-y-3">
        <div className="text-ok">
          <span aria-hidden style={{ background: "var(--ok)", display: "inline-block", width: 6, height: 6, marginRight: 8 }} />
          signed in
        </div>
        <p className="text-muted">
          routing claude code through your github copilot plan now. taking you
          to the dashboard…
        </p>
      </div>
    </div>
  );
}
