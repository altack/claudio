// Diagnostic chat endpoint. Forwards a multi-turn conversation through
// LiteLLM's Anthropic Messages format. The webapp's ChatPanel uses this for
// the per-model "chat ▸" button — quick way to verify a model alias is
// actually serving end-to-end and watch token consumption.

import { NextResponse } from "next/server";
import { LITELLM_BASE_URL, getLitellmMasterKey } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ChatRole = "user" | "assistant";
type Message = { role: ChatRole; content: string };

type AnthropicMessagesResponse = {
  content?: Array<{ type: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
};

export async function POST(req: Request) {
  let body: { model?: string; messages?: Message[]; max_tokens?: number };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid json body" },
      { status: 400 },
    );
  }

  const { model, messages } = body;
  if (typeof model !== "string" || !model) {
    return NextResponse.json(
      { ok: false, error: "model is required" },
      { status: 400 },
    );
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    return NextResponse.json(
      { ok: false, error: "messages must be a non-empty array" },
      { status: 400 },
    );
  }
  // Sanity-check the conversation shape; LiteLLM accepts it but garbage
  // bodies should be caught here so we never proxy them.
  for (const m of messages) {
    if (
      !m ||
      (m.role !== "user" && m.role !== "assistant") ||
      typeof m.content !== "string"
    ) {
      return NextResponse.json(
        { ok: false, error: "each message needs {role, content}" },
        { status: 400 },
      );
    }
  }

  const max_tokens =
    Number.isFinite(body.max_tokens) && body.max_tokens! > 0
      ? Math.min(body.max_tokens!, 4096)
      : 1024;

  const start = Date.now();
  try {
    const upstream = await fetch(new URL("/v1/messages", LITELLM_BASE_URL), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${getLitellmMasterKey()}`,
      },
      body: JSON.stringify({ model, messages, max_tokens }),
      cache: "no-store",
    });
    const latency_ms = Date.now() - start;

    if (!upstream.ok) {
      const text = await upstream.text();
      return NextResponse.json(
        {
          ok: false,
          status: upstream.status,
          error: text.slice(0, 800),
          latency_ms,
        },
        { status: upstream.status === 401 ? 401 : 502 },
      );
    }

    const data = (await upstream.json()) as AnthropicMessagesResponse;
    const content =
      data.content?.find((c) => c.type === "text" && typeof c.text === "string")
        ?.text ?? "";
    return NextResponse.json({
      ok: true,
      content,
      usage: {
        input_tokens: data.usage?.input_tokens ?? 0,
        output_tokens: data.usage?.output_tokens ?? 0,
      },
      latency_ms,
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
