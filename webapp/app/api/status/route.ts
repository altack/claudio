import { NextResponse } from "next/server";
import { health } from "@/lib/litellm";
import { readAuthSnapshot } from "@/lib/copilot-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const [proxy, auth] = await Promise.all([health(), readAuthSnapshot()]);
  return NextResponse.json({ proxy, auth });
}
