"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, qs } from "./api";
import type {
  DocumentDetail,
  DocumentPage,
  DocumentSummary,
  Health,
  InvoiceDetail,
  InvoiceHistory,
  InvoiceListRow,
  Paged,
  ProcessingEvent,
  Reconciliation,
  ReconciliationListRow,
  SearchResponse,
  Stats,
} from "./types";

const ACTIVE = new Set(["queued", "processing", "analyzing"]);
export const isActive = (status: string | undefined) => !!status && ACTIVE.has(status);

/** Poll every 3 s while something visible is still processing (fallback when SSE is unavailable). */
const pollWhile = (active: boolean) => (active ? 3000 : false);

export function useStats() {
  return useQuery({ queryKey: ["stats"], queryFn: () => api<Stats>("/stats"), refetchInterval: 15_000 });
}

export function useHealth() {
  return useQuery({
    queryKey: ["health"],
    queryFn: async () => {
      const res = await fetch("/api/health", { cache: "no-store" });
      if (!res.ok) throw new Error("unreachable");
      return (await res.json()) as Health;
    },
    refetchInterval: 30_000,
    retry: false,
  });
}

export interface DocumentFilters {
  status?: string;
  fileType?: string;
  needsReview?: boolean;
  q?: string;
  page?: number;
  pageSize?: number;
}

export function useDocuments(filters: DocumentFilters) {
  return useQuery({
    queryKey: ["documents", filters],
    queryFn: () => api<Paged<DocumentSummary>>(`/documents${qs({ ...filters })}`),
    placeholderData: keepPreviousData,
    refetchInterval: (q) => pollWhile(!!q.state.data?.items.some((d) => isActive(d.status))),
  });
}

export function useDocument(id: string) {
  return useQuery({
    queryKey: ["document", id],
    queryFn: () => api<DocumentDetail>(`/documents/${id}`),
    refetchInterval: (q) => pollWhile(isActive(q.state.data?.status)),
  });
}

export function useDocumentEvents(id: string, active: boolean) {
  return useQuery({
    queryKey: ["document-events", id],
    queryFn: () => api<{ items: ProcessingEvent[] }>(`/documents/${id}/events`),
    refetchInterval: pollWhile(active),
  });
}

export function useDocumentPages(id: string | undefined, from: number, to: number, enabled = true) {
  return useQuery({
    queryKey: ["document-pages", id, from, to],
    queryFn: () => api<{ items: DocumentPage[] }>(`/documents/${id}/pages${qs({ from, to })}`),
    enabled: !!id && enabled,
    staleTime: 60_000,
  });
}

export interface InvoiceFilters {
  q?: string;
  status?: string;
  supplier?: string;
  customer?: string;
  currency?: string;
  dateFrom?: string;
  dateTo?: string;
  minTotal?: string;
  maxTotal?: string;
  documentId?: string;
  issue?: string;
  sort?: "created_at" | "invoice_date" | "total" | "confidence";
  order?: "asc" | "desc";
  page?: number;
  pageSize?: number;
}

export function useInvoices(filters: InvoiceFilters, enabled = true) {
  return useQuery({
    queryKey: ["invoices", filters],
    queryFn: () => api<Paged<InvoiceListRow>>(`/invoices${qs({ ...filters })}`),
    placeholderData: keepPreviousData,
    enabled,
  });
}

export function useInvoice(id: string) {
  return useQuery({ queryKey: ["invoice", id], queryFn: () => api<InvoiceDetail>(`/invoices/${id}`) });
}

export function useInvoiceHistory(id: string, enabled: boolean) {
  return useQuery({ queryKey: ["invoice-history", id], queryFn: () => api<InvoiceHistory>(`/invoices/${id}/history`), enabled });
}

export function useSearch(params: Record<string, string | number | undefined>, enabled: boolean) {
  return useQuery({
    queryKey: ["search", params],
    queryFn: () => api<SearchResponse>(`/search${qs(params)}`),
    enabled,
    placeholderData: keepPreviousData,
  });
}

export function useReconciliations() {
  return useQuery({ queryKey: ["reconciliations"], queryFn: () => api<ReconciliationListRow[]>("/reconciliations") });
}

export function useReconciliation(id: string | null) {
  return useQuery({ queryKey: ["reconciliation", id], queryFn: () => api<Reconciliation>(`/reconciliations/${id}`), enabled: !!id });
}

/** Invalidate everything that summarises documents/invoices after a mutation or live event. */
export function useRefreshAll() {
  const qc = useQueryClient();
  return () => {
    for (const key of ["documents", "document", "stats", "invoices", "invoice", "search", "document-events"]) {
      void qc.invalidateQueries({ queryKey: [key] });
    }
  };
}

export function useReprocess() {
  const refresh = useRefreshAll();
  return useMutation({
    mutationFn: ({ id, force }: { id: string; force?: boolean }) => api<DocumentSummary>(`/documents/${id}/reprocess`, { method: "POST", json: force ? { force: true } : {} }),
    onSuccess: refresh,
  });
}

export function useDeleteDocument() {
  const refresh = useRefreshAll();
  return useMutation({ mutationFn: (id: string) => api<void>(`/documents/${id}`, { method: "DELETE" }), onSuccess: refresh });
}

export function useRetryFailed() {
  const refresh = useRefreshAll();
  return useMutation({ mutationFn: () => api<{ retried: number; skipped: number }>("/jobs/retry-failed", { method: "POST" }), onSuccess: refresh });
}
