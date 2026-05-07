import { NextResponse } from "next/server";
import { smokeTest } from "@/lib/litellm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const url = new URL(req.url);
  const model = url.searchParams.get("model") ?? undefined;
  const result = await smokeTest(model);
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}
