import { NextResponse } from "next/server";
import { startDeviceFlow } from "@/lib/copilot-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const start = await startDeviceFlow();
    return NextResponse.json(start);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
