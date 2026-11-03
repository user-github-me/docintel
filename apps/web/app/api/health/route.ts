import type { NextRequest } from "next/server";
import { AUTH_CHALLENGE, checkBasicAuth } from "@/lib/basic-auth";

export const dynamic = "force-dynamic";

/** Proxies the API's public /health endpoint (status of database, queue, processor and LLM). */
export async function GET(request: NextRequest): Promise<Response> {
  if (!checkBasicAuth(request.headers.get("authorization")).ok) return new Response("Authentication required", { status: 401, headers: AUTH_CHALLENGE });
  try {
    const res = await fetch(new URL("/health", process.env.API_URL ?? "http://localhost:4000"), { cache: "no-store", signal: AbortSignal.timeout(5000) });
    return new Response(res.body, { status: res.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  } catch {
    return Response.json({ status: "down" }, { status: 502 });
  }
}
