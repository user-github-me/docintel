"use client";

import { AlertCircle, AlertTriangle, ArrowRight } from "lucide-react";
import Link from "next/link";
import { DocumentsTable } from "@/components/documents-table";
import { UploadDropzone } from "@/components/upload-dropzone";
import { ButtonLink, EmptyState, ErrorState, Panel, PageHeader, SkeletonRows } from "@/components/ui";
import { compact, duration, ISSUE_LABELS, money, percent } from "@/lib/format";
import { useDocuments, useInvoices, useStats } from "@/lib/queries";
import type { Stats } from "@/lib/types";

function Pipeline({ stats }: { stats: Stats | undefined }) {
  const s = stats?.documents.byStatus ?? {};
  const steps = [
    { key: "queued", label: "Queued", n: s.queued ?? 0, hint: "waiting for a worker" },
    { key: "processing", label: "Reading", n: s.processing ?? 0, hint: "text layer and OCR" },
    { key: "analyzing", label: "Extracting", n: s.analyzing ?? 0, hint: "fields and validation" },
    { key: "completed", label: "Completed", n: s.completed ?? 0, hint: "searchable" },
  ];
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-stretch" aria-label="Processing pipeline">
      <ol className="flex flex-1 items-stretch overflow-hidden rounded-lg border border-line bg-surface">
        {steps.map((step, i) => (
          <li key={step.key} className="relative flex flex-1 items-center gap-3 px-4 py-3">
            {i > 0 && <span className="absolute top-1/2 left-0 h-6 w-px -translate-y-1/2 bg-line" aria-hidden />}
            <span className="num text-[22px] leading-none font-semibold text-ink">{step.n}</span>
            <span className="min-w-0 leading-tight">
              <span className="block text-[13px] font-medium text-ink-soft">{step.label}</span>
              <span className="block truncate text-xs text-faint">{step.hint}</span>
            </span>
            {i < steps.length - 1 && <ArrowRight className="ml-auto hidden h-4 w-4 text-line lg:block" aria-hidden />}
          </li>
        ))}
      </ol>
      <Link
        href="/documents?status=failed"
        className="flex items-center gap-3 rounded-lg border border-line bg-surface px-4 py-3 hover:border-danger/40 sm:w-[210px]"
      >
        <span className={`num text-[22px] leading-none font-semibold ${s.failed ? "text-danger" : "text-ink"}`}>{s.failed ?? 0}</span>
        <span className="leading-tight">
          <span className="block text-[13px] font-medium text-ink-soft">Failed</span>
          <span className="block text-xs text-faint">corrupt or unreadable files</span>
        </span>
      </Link>
    </div>
  );
}

function Metric({ label, value, detail }: { label: string; value: React.ReactNode; detail?: React.ReactNode }) {
  return (
    <div className="min-w-[150px] flex-1 px-4 py-3">
      <dt className="text-[12.5px] text-muted">{label}</dt>
      <dd className="num mt-1 text-[20px] leading-tight font-semibold text-ink">{value}</dd>
      {detail && <dd className="mt-0.5 text-xs text-faint">{detail}</dd>}
    </div>
  );
}

function ReviewPanel() {
  const { data, isLoading, error, refetch } = useInvoices({ status: "needs_review", pageSize: 6, sort: "created_at", order: "desc" });
  const { data: stats } = useStats();
  const merged = new Map<string, number>();
  for (const i of stats?.topIssues ?? []) if (i.severity !== "info") merged.set(i.code, (merged.get(i.code) ?? 0) + i.n);
  const top = [...merged.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([code, n]) => ({ code, n }));
  return (
    <Panel
      title="Needs your review"
      description="Invoices with validation errors or uncertain fields."
      actions={<ButtonLink href="/review" size="sm">Open queue</ButtonLink>}
      className="h-full"
      bodyClassName="p-0"
    >
      {isLoading ? (
        <div className="px-4">
          <SkeletonRows rows={4} />
        </div>
      ) : error ? (
        <div className="p-4">
          <ErrorState error={error} onRetry={() => refetch()} />
        </div>
      ) : !data?.items.length ? (
        <EmptyState title="Nothing to review">Every extracted invoice passed validation. New uploads that need a human appear here.</EmptyState>
      ) : (
        <>
          <ul className="divide-y divide-line-soft">
            {data.items.map((inv) => (
              <li key={inv.id}>
                <Link href={`/invoices/${inv.id}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-paper/50">
                  {inv.errors > 0 ? <AlertCircle className="h-4 w-4 shrink-0 text-danger" aria-label="Has errors" /> : <AlertTriangle className="h-4 w-4 shrink-0 text-warn" aria-label="Has warnings" />}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-ink">{inv.supplier_name ?? "Unknown supplier"}</span>
                    <span className="block truncate text-xs text-muted">
                      {inv.invoice_number ?? "No invoice number"}, {inv.filename}
                    </span>
                  </span>
                  <span className="num text-right text-sm text-ink">
                    {money(inv.total)} <span className="text-xs text-muted">{inv.currency ?? ""}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          {top.length > 0 && (
            <div className="flex flex-wrap gap-1.5 border-t border-line-soft px-4 py-3">
              {top.map((i) => (
                <Link key={i.code} href={`/review?issue=${i.code}`} className="rounded-full border border-line px-2 py-0.5 text-xs text-ink-soft hover:border-ledger hover:text-ledger">
                  {ISSUE_LABELS[i.code] ?? i.code} <span className="num text-faint">{i.n}</span>
                </Link>
              ))}
            </div>
          )}
        </>
      )}
    </Panel>
  );
}

export default function OverviewPage() {
  const { data: stats, error: statsError, refetch } = useStats();
  const docs = useDocuments({ page: 1, pageSize: 8 });
  const total = stats?.invoices.total ?? 0;
  return (
    <>
      <PageHeader
        title="Overview"
        description="Upload invoices, receipts and registers. Reading, extraction and validation run in the background; anything uncertain lands in the review queue."
      />
      {statsError && (
        <div className="mb-4">
          <ErrorState error={statsError} onRetry={() => refetch()} />
        </div>
      )}
      <div className="grid gap-5 lg:grid-cols-12">
        <Panel title="Upload documents" className="flex flex-col lg:col-span-7" bodyClassName="flex flex-1 flex-col">
          <UploadDropzone grow />
        </Panel>
        <div className="lg:col-span-5">
          <ReviewPanel />
        </div>
      </div>

      <section className="mt-5" aria-label="Pipeline">
        <Pipeline stats={stats} />
      </section>

      <section className="mt-5 rounded-lg border border-line bg-surface" aria-label="Key figures">
        <dl className="flex flex-wrap divide-x divide-line-soft">
          <Metric label="Documents" value={stats ? stats.documents.total : "—"} detail={stats ? `${stats.processing.pages} pages read` : undefined} />
          <Metric label="Processed successfully" value={percent(stats?.successRate, 1)} detail={stats ? `${percent(stats.failureRate, 1)} failed` : undefined} />
          <Metric
            label="Invoices extracted"
            value={stats ? total : "—"}
            detail={stats ? `${stats.invoices.validated + stats.invoices.approved} passed, ${stats.invoices.needs_review} to review` : undefined}
          />
          <Metric label="Median processing time" value={duration(stats?.processing.p50_ms)} detail={stats ? `95th percentile ${duration(stats.processing.p95_ms)}` : undefined} />
          <Metric
            label="AI calls"
            value={stats ? compact(stats.llm.calls) : "—"}
            detail={stats ? (stats.llm.calls ? `${compact(stats.llm.input_tokens)} in, ${compact(stats.llm.output_tokens)} out tokens` : "rules handled everything") : undefined}
          />
        </dl>
      </section>

      <Panel
        title="Recent documents"
        className="mt-5"
        actions={<ButtonLink href="/documents" size="sm">All documents</ButtonLink>}
      >
        {docs.isLoading ? (
          <SkeletonRows rows={5} />
        ) : docs.error ? (
          <ErrorState error={docs.error} onRetry={() => docs.refetch()} />
        ) : !docs.data?.items.length ? (
          <EmptyState title="No documents yet">Upload a PDF, scan, photo, Excel or CSV file above to get started.</EmptyState>
        ) : (
          <DocumentsTable documents={docs.data.items} compact />
        )}
      </Panel>
    </>
  );
}
