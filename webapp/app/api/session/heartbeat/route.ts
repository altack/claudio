import { NextResponse } from "next/server";
import { recordHeartbeat } from "@/lib/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { id?: string };
  if (!body.id) {
    return NextResponse.json({ error: "missing id" }, { status: 400 });
  }
  recordHeartbeat(body.id);
  return new NextResponse(null, { status: 204 });
}
