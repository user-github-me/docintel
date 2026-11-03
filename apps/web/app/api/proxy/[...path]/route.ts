import type { NextRequest } from "next/server";
import { AUTH_CHALLENGE, checkBasicAuth } from "@/lib/basic-auth";

/**
 * Backend-for-frontend proxy: /api/proxy/<path> -> ${API_URL}/api/v1/<path>.
 * Adds the API key server-side, forwards the signed-in reviewer as X-Actor, and streams request
 * and response bodies (uploads up to 200 MB, page images, downloads, server-sent events).
 */
export const dynamic = "force-dynamic";

const API_URL = process.env.API_URL ?? "http://localhost:4000";
const API_KEY = process.env.API_KEY ?? "";
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;
const FORWARD_REQUEST = ["content-type", "accept", "last-event-id"];
const FORWARD_RESPONSE = ["content-type", "content-disposition", "cache-control", "x-content-type-options", "etag", "last-modified"];

async function handle(request: NextRequest, ctx: RouteContext<"/api/proxy/[...path]">): Promise<Response> {
  const auth = checkBasicAuth(request.headers.get("authorization"));
  if (!auth.ok) return new Response("Authentication required", { status: 401, headers: AUTH_CHALLENGE });

  const { path } = await ctx.params;
  if (!path.length || !path.every((s) => SAFE_SEGMENT.test(s) && s !== "." && s !== "..")) {
    return Response.json({ message: "Invalid path" }, { status: 400 });
  }
  const target = new URL(`/api/v1/${path.join("/")}`, API_URL);
  target.search = request.nextUrl.search;

  const headers = new Headers();
  for (const name of FORWARD_REQUEST) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("x-api-key", API_KEY);
  if (auth.user) headers.set("x-actor", auth.user);

  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers,
    redirect: "manual",
    cache: "no-store",
    signal: request.signal,
  };
  if (request.method !== "GET" && request.method !== "HEAD" && request.body) {
    init.body = request.body;
    init.duplex = "half";
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, init);
  } catch (err) {
    if (request.signal.aborted) return new Response(null, { status: 499 });
    return Response.json({ message: "The DocIntel API is not reachable.", detail: (err as Error).message }, { status: 502 });
  }

  const out = new Headers();
  for (const name of FORWARD_RESPONSE) {
    const value = upstream.headers.get(name);
    if (value) out.set(name, value);
  }
  if (upstream.headers.get("content-type")?.includes("text/event-stream")) {
    out.set("cache-control", "no-cache, no-transform");
    out.set("x-accel-buffering", "no");
    out.set("connection", "keep-alive");
  }
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out });
}

export { handle as GET, handle as POST, handle as PATCH, handle as PUT, handle as DELETE };
