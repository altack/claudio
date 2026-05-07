"use client";

import { useEffect, useRef, useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

type Role = "user" | "assistant";

type ChatMessage = {
  role: Role;
  content: string;
  usage?: { input_tokens: number; output_tokens: number };
  latency_ms?: number;
};

type ErrorEntry = {
  kind: "error";
  message: string;
  status?: number;
};

type Entry = ChatMessage | ErrorEntry;

function isError(e: Entry): e is ErrorEntry {
  return "kind" in e && e.kind === "error";
}

const STARTER_PROMPTS = [
  "say hello",
  "what model are you?",
  "respond with just: pong",
];

export default function ChatPanel({
  model,
  onClose,
}: {
  model: string | null;
  onClose: () => void;
}) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  // Track the model the current state belongs to. When the parent swaps in
  // a new model we reset state during render rather than in an effect — this
  // is the React-recommended pattern for "reset state when a prop changes"
  // and avoids the setState-in-effect cascade.
  const [activeModel, setActiveModel] = useState<string | null>(model);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  if (activeModel !== model) {
    setActiveModel(model);
    setEntries([]);
    setInput("");
    setSending(false);
  }

  // Focus the textarea shortly after the panel opens.
  useEffect(() => {
    if (!model) return;
    const id = window.setTimeout(() => inputRef.current?.focus(), 80);
    return () => window.clearTimeout(id);
  }, [model]);

  // Stick to bottom on new messages.
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries, sending]);

  async function send(textOverride?: string) {
    const text = (textOverride ?? input).trim();
    if (!model || !text || sending) return;
    const userMsg: ChatMessage = { role: "user", content: text };
    const nextEntries: Entry[] = [...entries, userMsg];
    setEntries(nextEntries);
    setInput("");
    setSending(true);

    const conversation = nextEntries
      .filter((e): e is ChatMessage => !isError(e))
      .map(({ role, content }) => ({ role, content }));

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, messages: conversation }),
      });
      const data = (await res.json()) as
        | {
            ok: true;
            content: string;
            usage: { input_tokens: number; output_tokens: number };
            latency_ms: number;
          }
        | { ok: false; error: string; status?: number; latency_ms?: number };

      if (!data.ok) {
        setEntries([
          ...nextEntries,
          { kind: "error", message: data.error, status: data.status },
        ]);
      } else {
        setEntries([
          ...nextEntries,
          {
            role: "assistant",
            content: data.content,
            usage: data.usage,
            latency_ms: data.latency_ms,
          },
        ]);
      }
    } catch (err) {
      setEntries([
        ...nextEntries,
        {
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        },
      ]);
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  }

  function handleKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  function reset() {
    setEntries([]);
    setInput("");
    inputRef.current?.focus();
  }

  const chatMsgs = entries.filter((e): e is ChatMessage => !isError(e));
  const totalIn = chatMsgs.reduce(
    (s, m) => s + (m.usage?.input_tokens ?? 0),
    0,
  );
  const totalOut = chatMsgs.reduce(
    (s, m) => s + (m.usage?.output_tokens ?? 0),
    0,
  );
  const turnCount = chatMsgs.filter((m) => m.role === "assistant").length;
  const isEmpty = entries.length === 0 && !sending;

  return (
    <Sheet open={!!model} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="right"
        className="w-full p-0 border-l border-hairline gap-0"
        style={{ background: "var(--bg)", maxWidth: 680 }}
      >
        <div className="flex h-full flex-col">
          <SheetHeader className="px-5 py-4 pr-14 border-b border-hairline gap-0">
            <SheetTitle className="m-0 font-normal text-[13px]">
              <div className="flex items-baseline gap-3 min-w-0">
                <span className="text-[11px] tracking-[0.14em] text-muted uppercase shrink-0">
                  chat
                </span>
                <span className="text-fg truncate">{model ?? ""}</span>
                {turnCount > 0 && (
                  <button
                    type="button"
                    onClick={reset}
                    className="ml-auto shrink-0 text-[11px] text-muted hover:text-err underline-offset-4 hover:underline"
                  >
                    new chat
                  </button>
                )}
              </div>
            </SheetTitle>
          </SheetHeader>

          <div
            ref={scrollRef}
            className="flex-1 overflow-y-auto px-5 py-5"
          >
            {isEmpty ? (
              <EmptyState
                model={model ?? ""}
                onPick={(prompt) => {
                  setInput(prompt);
                  inputRef.current?.focus();
                }}
              />
            ) : (
              <div className="space-y-6">
                {entries.map((entry, i) =>
                  isError(entry) ? (
                    <ErrorRow key={i} entry={entry} />
                  ) : (
                    <MessageRow key={i} message={entry} />
                  ),
                )}
                {sending && <ThinkingRow />}
              </div>
            )}
          </div>

          <div className="border-t border-hairline px-5 py-3">
            <div className="mb-2 flex items-baseline justify-between text-[11px] text-muted">
              <span>
                {chatMsgs.length === 0 ? (
                  "no tokens consumed yet"
                ) : (
                  <>
                    <span className="text-fg tabular-nums">{totalIn}</span> in
                    {" · "}
                    <span className="text-fg tabular-nums">{totalOut}</span> out
                    {" · "}
                    <span className="text-fg tabular-nums">
                      {totalIn + totalOut}
                    </span>{" "}
                    total
                  </>
                )}
              </span>
              <span>
                {turnCount} turn{turnCount === 1 ? "" : "s"}
              </span>
            </div>
            <div className="flex items-stretch gap-2">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKey}
                placeholder="message…"
                disabled={sending || !model}
                rows={3}
                className="flex-1 bg-bg border border-hairline px-3 py-2 text-fg text-[13px] resize-none focus:outline-none focus:border-accent disabled:opacity-50 placeholder:text-dim"
                style={{
                  fontFamily: "var(--font-mono), ui-monospace, monospace",
                }}
              />
              <button
                type="button"
                onClick={() => void send()}
                disabled={!input.trim() || sending}
                className="shrink-0 self-stretch border border-accent px-4 text-accent hover:bg-accent hover:text-bg disabled:border-hairline disabled:text-dim disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-dim transition-colors flex flex-col items-center justify-center gap-1"
              >
                <span>{sending ? "…" : "send"}</span>
                {!sending && (
                  <span className="text-[10px] text-muted">↵</span>
                )}
              </button>
            </div>
            <div className="mt-2 text-[11px] text-dim">
              Enter sends · Shift+Enter for newline · close to discard
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function EmptyState({
  model,
  onPick,
}: {
  model: string;
  onPick: (prompt: string) => void;
}) {
  return (
    <div className="space-y-6">
      <div className="text-muted text-[13px] leading-relaxed">
        diagnostic chat with{" "}
        <span className="text-fg">{model}</span>. ephemeral — closing this
        panel discards the conversation.
      </div>
      <div className="space-y-2">
        <div className="text-[11px] tracking-[0.14em] text-muted uppercase">
          starter prompts
        </div>
        {STARTER_PROMPTS.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => onPick(p)}
            className="w-full text-left flex items-baseline gap-3 py-1 text-[13px] text-muted hover:text-fg transition-colors group"
          >
            <span className="text-dim group-hover:text-accent">▸</span>
            <span className="flex-1 truncate">{p}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function MessageRow({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between text-[11px] tracking-[0.14em] uppercase">
        <span className={isUser ? "text-accent" : "text-muted"}>
          {message.role}
        </span>
        {message.usage && (
          <span className="text-dim normal-case tracking-normal">
            <span className="text-muted tabular-nums">
              {message.usage.input_tokens}
            </span>
            {" in · "}
            <span className="text-muted tabular-nums">
              {message.usage.output_tokens}
            </span>
            {" out"}
            {message.latency_ms != null && (
              <>
                {" · "}
                <span className="text-muted tabular-nums">
                  {message.latency_ms}ms
                </span>
              </>
            )}
          </span>
        )}
      </div>
      <div
        className={`whitespace-pre-wrap break-words text-[13px] leading-relaxed border-l-2 pl-3 ${
          isUser ? "border-accent text-fg" : "border-hairline-strong text-fg"
        }`}
      >
        {message.content}
      </div>
    </div>
  );
}

function ErrorRow({ entry }: { entry: ErrorEntry }) {
  return (
    <div className="space-y-1">
      <div className="text-err text-[11px] tracking-[0.14em] uppercase">
        error{entry.status ? ` · ${entry.status}` : ""}
      </div>
      <pre
        className="text-err text-[12px] whitespace-pre-wrap break-words border-l-2 border-err pl-3"
        style={{ fontFamily: "var(--font-mono), ui-monospace, monospace" }}
      >
        {entry.message}
      </pre>
    </div>
  );
}

function ThinkingRow() {
  return (
    <div className="space-y-1">
      <div className="text-muted text-[11px] tracking-[0.14em] uppercase">
        assistant
      </div>
      <div className="text-muted animate-pulse text-[13px] border-l-2 border-hairline-strong pl-3">
        thinking…
      </div>
    </div>
  );
}
