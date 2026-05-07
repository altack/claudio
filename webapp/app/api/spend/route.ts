import { NextResponse } from "next/server";
import { getSpendByDay } from "@/lib/litellm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const days = Number(url.searchParams.get("days") ?? "14");
  const rows = await getSpendByDay(Number.isFinite(days) ? days : 14);
  return NextResponse.json({ rows });
}
