import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Optional HTTP basic auth for the whole web app (WEB_BASIC_AUTH="user:password").
 * Used by proxy.ts for pages and by the BFF route itself, because uploads bypass proxy.ts
 * (proxy buffers request bodies, which would cap uploads at 10 MB).
 */
export function checkBasicAuth(header: string | null): { ok: boolean; user: string | null } {
  const expected = process.env.WEB_BASIC_AUTH;
  if (!expected) return { ok: true, user: null };
  if (!header?.startsWith("Basic ")) return { ok: false, user: null };
  let decoded = "";
  try {
    decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  } catch {
    return { ok: false, user: null };
  }
  const a = createHash("sha256").update(decoded).digest();
  const b = createHash("sha256").update(expected).digest();
  const ok = timingSafeEqual(a, b);
  return { ok, user: ok ? decoded.split(":")[0] : null };
}

export const AUTH_CHALLENGE = { "WWW-Authenticate": 'Basic realm="DocIntel", charset="UTF-8"' };
