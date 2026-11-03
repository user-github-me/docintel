"use client";

import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { LiveEvent } from "@/lib/types";

/** Subscribes to server-sent events and refreshes affected queries (throttled). */
function LiveUpdates() {
  const qc = useQueryClient();
  const pending = useRef<Set<string>>(new Set());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const flush = () => {
      timer.current = null;
      const keys = [...pending.current];
      pending.current.clear();
      for (const k of keys) void qc.invalidateQueries({ queryKey: k.split("|").filter(Boolean).length > 1 ? k.split("|") : [k] });
    };
    const queue = (...keys: string[]) => {
      keys.forEach((k) => pending.current.add(k));
      if (!timer.current) timer.current = setTimeout(flush, 400);
    };

    const connect = () => {
      if (closed) return;
      source = new EventSource("/api/proxy/events");
      source.onmessage = (msg) => {
        let event: LiveEvent;
        try {
          event = JSON.parse(msg.data) as LiveEvent;
        } catch {
          return;
        }
        if (event.type === "heartbeat") return;
        queue("documents", "stats");
        if (event.documentId) queue(`document|${event.documentId}`, `document-events|${event.documentId}`);
        if (event.type === "invoice.updated" || event.status === "completed") queue("invoices", "search");
        if (event.invoiceId) queue(`invoice|${event.invoiceId}`);
      };
      source.onerror = () => {
        source?.close();
        if (!closed) retry = setTimeout(connect, 5000);
      };
    };
    connect();
    return () => {
      closed = true;
      source?.close();
      if (retry) clearTimeout(retry);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [qc]);
  return null;
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 5_000, refetchOnWindowFocus: true, retry: (count, err) => count < 2 && !(err && typeof err === "object" && "status" in err && [400, 401, 404].includes((err as { status: number }).status)) },
        },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      <LiveUpdates />
      {children}
    </QueryClientProvider>
  );
}
