/**
 * Browser-side API client. Every call goes through the Next.js BFF (/api/proxy/*), which adds
 * the API key on the server; the key never reaches the browser.
 */

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body: unknown,
  ) {
    super(message);
  }
}

export const PROXY = "/api/proxy";

function messageFrom(body: unknown, fallback: string): string {
  if (body && typeof body === "object") {
    const m = (body as { message?: unknown }).message;
    if (Array.isArray(m)) return m.join("; ");
    if (typeof m === "string") return m;
  }
  return fallback;
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, headers, ...rest } = init;
  const res = await fetch(`${PROXY}${path}`, {
    ...rest,
    headers: { Accept: "application/json", ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
    cache: "no-store",
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const fallback =
      res.status === 502
        ? "The DocIntel API is not reachable. Check that the API service is running."
        : res.status === 401
          ? "Not authorised. Sign in again."
          : `Request failed (${res.status})`;
    throw new ApiError(res.status, messageFrom(body, fallback), body);
  }
  return body as T;
}

/** Build a query string, dropping empty values (the API rejects unknown or blank parameters). */
export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    u.set(k, String(v));
  }
  const s = u.toString();
  return s ? `?${s}` : "";
}

export const pageImageUrl = (documentId: string, page: number) => `${PROXY}/documents/${documentId}/pages/${page}/image`;
export const fileUrl = (documentId: string) => `${PROXY}/documents/${documentId}/file`;

/** Multipart upload with progress (fetch has no upload progress events). */
export function uploadFiles(
  files: File[],
  purpose: "invoices" | "reference",
  onProgress: (fraction: number) => void,
): Promise<import("./types").UploadResponse> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    for (const f of files) form.append("files", f, f.name);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${PROXY}/documents${qs({ purpose })}`);
    xhr.responseType = "json";
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.response);
      else reject(new ApiError(xhr.status, messageFrom(xhr.response, `Upload failed (${xhr.status})`), xhr.response));
    };
    xhr.onerror = () => reject(new ApiError(0, "Upload failed: the connection was interrupted.", null));
    xhr.send(form);
  });
}
