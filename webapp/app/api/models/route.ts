import { NextResponse } from "next/server";
import { listModels } from "@/lib/litellm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const rows = await listModels();
    return NextResponse.json({ models: rows });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
