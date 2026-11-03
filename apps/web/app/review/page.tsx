"use client";

import { ClipboardCheck } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import { InvoicesTable } from "@/components/invoices-table";
import { Button, EmptyState, ErrorState, Panel, PageHeader, Segmented, Select, SkeletonRows } from "@/components/ui";
import { cn, ISSUE_LABELS } from "@/lib/format";
import { useInvoices, useStats } from "@/lib/queries";

const COMMON_ISSUES = ["TOTAL_MISMATCH", "LINE_ITEMS_MISMATCH", "DUPLICATE_INVOICE", "MISSING_FIELD", "LOW_CONFIDENCE", "LOW_OCR_QUALITY", "EXTRACTION_CONFLICT", "DATE_AMBIGUOUS"];

const SORTS = {
  newest: { sort: "created_at", order: "desc", label: "Newest first" },
  oldest: { sort: "created_at", order: "asc", label: "Oldest first" },
  total: { sort: "total", order: "desc", label: "Largest amount first" },
  confidence: { sort: "confidence", order: "asc", label: "Least confident first" },
} as const;

function ReviewInner() {
  const params = useSearchParams();
  const [issue, setIssue] = useState(params.get("issue") ?? "");
  const [status, setStatus] = useState<"needs_review" | "validated" | "approved" | "rejected">("needs_review");
  const [sortKey, setSortKey] = useState<keyof typeof SORTS>("newest");
  const [page, setPage] = useState(1);
  const pageSize = 25;
  const { data: stats } = useStats();
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of stats?.topIssues ?? []) m.set(i.code, (m.get(i.code) ?? 0) + i.n);
    return m;
  }, [stats]);
  const codes = useMemo(() => [...new Set([...COMMON_ISSUES, ...counts.keys()])].filter((c) => c !== "AI_EXTRACTION_FAILED"), [counts]);
  const sort = SORTS[sortKey];
  const { data, isLoading, error, refetch } = useInvoices({ status, issue: issue || undefined, sort: sort.sort, order: sort.order, page, pageSize });

  return (
    <>
      <PageHeader
        title="Review queue"
        description="Invoices that failed a validation check or have uncertain fields. Open one to compare each value with the document, correct it and approve."
      />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Segmented
          label="Invoice status"
          value={status}
          onChange={(v) => {
            setStatus(v);
            setPage(1);
          }}
          options={[
            { value: "needs_review", label: `Needs review${stats ? ` (${stats.invoices.needs_review})` : ""}` },
            { value: "validated", label: "Validated" },
            { value: "approved", label: "Approved" },
            { value: "rejected", label: "Rejected" },
          ]}
        />
        <Select aria-label="Sort" value={sortKey} onChange={(e) => setSortKey(e.target.value as keyof typeof SORTS)} className="w-[200px]">
          {Object.entries(SORTS).map(([k, v]) => (
            <option key={k} value={k}>
              {v.label}
            </option>
          ))}
        </Select>
      </div>
      <div className="mb-4 flex flex-wrap gap-1.5" role="group" aria-label="Filter by issue">
        <button
          type="button"
          onClick={() => {
            setIssue("");
            setPage(1);
          }}
          className={cn("rounded-full border px-2.5 py-1 text-[13px]", !issue ? "border-ledger bg-ledger-soft text-ledger-dark" : "border-line bg-surface text-ink-soft hover:border-[#b9c5c2]")}
        >
          All issues
        </button>
        {codes.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => {
              setIssue(c === issue ? "" : c);
              setPage(1);
            }}
            className={cn("rounded-full border px-2.5 py-1 text-[13px]", issue === c ? "border-ledger bg-ledger-soft text-ledger-dark" : "border-line bg-surface text-ink-soft hover:border-[#b9c5c2]")}
          >
            {ISSUE_LABELS[c] ?? c} {counts.get(c) ? <span className="num text-faint">{counts.get(c)}</span> : null}
          </button>
        ))}
      </div>
      <Panel bodyClassName="px-4 py-2">
        {isLoading ? (
          <SkeletonRows rows={8} />
        ) : error ? (
          <div className="py-3">
            <ErrorState error={error} onRetry={() => refetch()} />
          </div>
        ) : !data?.items.length ? (
          <EmptyState icon={<ClipboardCheck className="h-8 w-8" />} title={status === "needs_review" ? (issue ? "No invoices with this issue" : "The queue is clear") : "No invoices here yet"}>
            {status === "needs_review" ? "Invoices that need a person appear here as soon as validation flags them." : "Change the status filter to see other invoices."}
          </EmptyState>
        ) : (
          <InvoicesTable rows={data.items} showStatus={status !== "needs_review"} />
        )}
        {data && data.total > pageSize && (
          <div className="flex items-center justify-between border-t border-line-soft py-3 text-sm text-muted">
            <span className="num">
              {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, data.total)} of {data.total}
            </span>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => setPage((p) => p - 1)} disabled={page <= 1}>
                Previous
              </Button>
              <Button size="sm" onClick={() => setPage((p) => p + 1)} disabled={page * pageSize >= data.total}>
                Next
              </Button>
            </div>
          </div>
        )}
      </Panel>
    </>
  );
}

export default function ReviewPage() {
  return (
    <Suspense>
      <ReviewInner />
    </Suspense>
  );
}
