"use client";

import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeftRight, GitCompareArrows } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import { Badge, Button, EmptyState, ErrorState, Input, Label, Notice, Panel, PageHeader, Select, SkeletonRows, Spinner, Tabs } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { cn, date, dateTime, FIELD_LABELS, FILE_TYPE_LABELS, money } from "@/lib/format";
import { useDocuments, useReconciliation, useReconciliations } from "@/lib/queries";
import type { Reconciliation, ReconInvoice, ReconItem } from "@/lib/types";

const STATUS: Record<ReconItem["status"], { label: string; tone: "ok" | "danger" | "warn" | "info" }> = {
  matched: { label: "Matched", tone: "ok" },
  mismatch: { label: "Mismatch", tone: "danger" },
  missing_in_right: { label: "Only in left", tone: "warn" },
  missing_in_left: { label: "Only in right", tone: "info" },
};

function formatValue(field: string, v: string | number | null): string {
  if (v === null || v === undefined || v === "") return "missing";
  if (["subtotal", "tax", "total"].includes(field)) return money(v);
  if (field === "invoice_date") return date(String(v));
  return String(v);
}

function InvoiceCell({ inv }: { inv: ReconInvoice | null }) {
  if (!inv) return <span className="text-sm text-faint">Not present</span>;
  return (
    <div className="min-w-0">
      <span className="block truncate text-sm font-medium text-ink">{inv.invoice_number ?? "No number"}</span>
      <span className="block truncate text-xs text-muted">
        {inv.supplier_name ?? "Unknown supplier"}, {date(inv.invoice_date)}
      </span>
      <span className="num block text-xs text-ink-soft">
        {money(inv.total)} {inv.currency ?? ""}
      </span>
    </div>
  );
}

function Result({ rec }: { rec: Reconciliation }) {
  const [filter, setFilter] = useState<"all" | ReconItem["status"]>("all");
  const s = rec.summary;
  const diff = Number(s.difference);
  const items = rec.items.filter((i) => filter === "all" || i.status === filter);
  const cards = [
    { label: "Matched", value: s.matched, tone: "text-ok", hint: "values agree" },
    { label: "Mismatched", value: s.mismatched, tone: s.mismatched ? "text-danger" : "text-ink", hint: "values differ" },
    { label: "Only in left", value: s.missingInRight, tone: s.missingInRight ? "text-warn" : "text-ink", hint: rec.left_filename },
    { label: "Only in right", value: s.missingInLeft, tone: s.missingInLeft ? "text-info" : "text-ink", hint: rec.right_filename },
  ];
  return (
    <div data-testid="reconciliation-result">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="heading text-[19px] font-semibold">
          {rec.left_filename} <span className="text-faint">vs</span> {rec.right_filename}
        </h2>
        <span className="text-xs text-muted">
          Run {dateTime(rec.created_at)}
          {rec.created_by ? ` by ${rec.created_by}` : ""}, tolerance {money(rec.options.amountTolerance)} and {rec.options.dateToleranceDays} days
        </span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {cards.map((c) => (
          <div key={c.label} className="rounded-lg border border-line bg-surface px-4 py-3">
            <p className="text-[12.5px] text-muted">{c.label}</p>
            <p className={cn("num mt-1 text-[24px] leading-none font-semibold", c.tone)}>{c.value}</p>
            <p className="mt-1 truncate text-xs text-faint" title={c.hint}>
              {c.hint}
            </p>
          </div>
        ))}
        <div className="rounded-lg border border-line bg-surface px-4 py-3">
          <p className="text-[12.5px] text-muted">Totals difference</p>
          <p className={cn("num mt-1 text-[24px] leading-none font-semibold", Math.abs(diff) > 0.005 ? "text-danger" : "text-ok")}>
            {diff > 0 ? "+" : ""}
            {money(diff)}
          </p>
          <p className="num mt-1 truncate text-xs text-faint" title={`${money(s.leftTotal)} left, ${money(s.rightTotal)} right`}>
            right minus left
          </p>
        </div>
      </div>
      <div className="mt-5">
        <Tabs
          value={filter}
          onChange={setFilter}
          tabs={[
            { value: "all", label: "All", count: rec.items.length },
            { value: "mismatch", label: "Mismatched", count: s.mismatched },
            { value: "missing_in_right", label: "Only in left", count: s.missingInRight },
            { value: "missing_in_left", label: "Only in right", count: s.missingInLeft },
            { value: "matched", label: "Matched", count: s.matched },
          ]}
        />
      </div>
      <div className="mt-3 overflow-x-auto rounded-lg border border-line bg-surface">
        <table className="w-full min-w-[820px] text-sm">
          <thead>
            <tr className="border-b border-line text-left text-[12px] text-muted">
              <th className="px-4 py-2 font-medium">Result</th>
              <th className="px-3 py-2 font-medium">Left: {rec.left_filename}</th>
              <th className="px-3 py-2 font-medium">Right: {rec.right_filename}</th>
              <th className="px-3 py-2 font-medium">Differences</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line-soft">
            {items.map((item, i) => (
              <tr key={i} className="align-top">
                <td className="px-4 py-3">
                  <Badge tone={STATUS[item.status].tone}>{STATUS[item.status].label}</Badge>
                  {item.match_method && (
                    <span className="mt-1 block text-xs text-muted">
                      {item.match_method === "invoice_number" ? "by invoice number" : `by supplier, amount and date (${Math.round((item.match_score ?? 0) * 100)}%)`}
                    </span>
                  )}
                </td>
                <td className="max-w-[260px] px-3 py-3">
                  <InvoiceCell inv={item.left} />
                </td>
                <td className="max-w-[260px] px-3 py-3">
                  <InvoiceCell inv={item.right} />
                </td>
                <td className="px-3 py-3">
                  {item.discrepancies.length ? (
                    <ul className="space-y-1">
                      {item.discrepancies.map((d, k) => (
                        <li key={k} className="text-[13px]">
                          <span className="font-medium text-ink">{FIELD_LABELS[d.field] ?? d.field}</span>{" "}
                          <span className="num text-ink-soft">
                            {formatValue(d.field, d.left)} <span className="text-faint">vs</span> {formatValue(d.field, d.right)}
                          </span>
                          {d.difference && <span className={cn("num ml-1 text-xs", Number(d.difference) > 0 ? "text-danger" : "text-info")}>({Number(d.difference) > 0 ? "+" : ""}{money(d.difference)})</span>}
                        </li>
                      ))}
                    </ul>
                  ) : item.status === "matched" ? (
                    <span className="text-xs text-ok">All compared fields agree</span>
                  ) : (
                    <span className="text-xs text-muted">{item.status === "missing_in_right" ? "No matching invoice in the right document" : "No matching invoice in the left document"}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!items.length && <p className="py-8 text-center text-sm text-muted">Nothing in this category.</p>}
      </div>
    </div>
  );
}

function ReconcileInner() {
  const router = useRouter();
  const params = useSearchParams();
  const qc = useQueryClient();
  const selected = params.get("id");
  const docs = useDocuments({ status: "completed", pageSize: 200 });
  const history = useReconciliations();
  const detail = useReconciliation(selected);
  const [left, setLeft] = useState("");
  const [right, setRight] = useState("");
  const [tolerance, setTolerance] = useState("0.05");
  const [days, setDays] = useState("3");
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const options = useMemo(() => (docs.data?.items ?? []).filter((d) => d.invoiceCount > 0), [docs.data]);

  const run = async () => {
    setErr(null);
    setRunning(true);
    try {
      const rec = await api<Reconciliation>("/reconciliations", {
        method: "POST",
        json: { leftDocumentId: left, rightDocumentId: right, amountTolerance: Number(tolerance) || 0, dateToleranceDays: Number(days) || 0 },
      });
      qc.setQueryData(["reconciliation", rec.id], rec);
      void qc.invalidateQueries({ queryKey: ["reconciliations"] });
      router.replace(`/reconcile?id=${rec.id}`, { scroll: false });
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "The comparison could not be run.");
    } finally {
      setRunning(false);
    }
  };

  const label = (d: (typeof options)[number]) => `${d.filename} (${d.fileType ? FILE_TYPE_LABELS[d.fileType] : "?"}, ${d.invoiceCount} invoice${d.invoiceCount === 1 ? "" : "s"})`;

  return (
    <>
      <PageHeader
        title="Cross-verify"
        description="Compare the invoices in two processed documents, for example a batch of invoice PDFs against the accounts-payable register exported from Excel. Invoices are paired by number first, then by supplier, amount and date."
      />
      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 space-y-5">
          <Panel title="New comparison">
            <div className="grid items-end gap-3 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
              <div className="min-w-0">
                <Label htmlFor="left-doc">Left document</Label>
                <Select id="left-doc" value={left} onChange={(e) => setLeft(e.target.value)}>
                  <option value="">Choose, e.g. the invoice PDFs</option>
                  {options.map((d) => (
                    <option key={d.id} value={d.id} disabled={d.id === right}>
                      {label(d)}
                    </option>
                  ))}
                </Select>
              </div>
              <Button
                variant="ghost"
                className="mb-0.5"
                onClick={() => {
                  setLeft(right);
                  setRight(left);
                }}
                aria-label="Swap left and right"
              >
                <ArrowLeftRight className="h-4 w-4" aria-hidden />
              </Button>
              <div className="min-w-0">
                <Label htmlFor="right-doc">Right document</Label>
                <Select id="right-doc" value={right} onChange={(e) => setRight(e.target.value)}>
                  <option value="">Choose, e.g. the Excel register</option>
                  {options.map((d) => (
                    <option key={d.id} value={d.id} disabled={d.id === left}>
                      {label(d)}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap items-end gap-3">
              <div className="w-[160px]">
                <Label htmlFor="tol">Amount tolerance</Label>
                <Input id="tol" inputMode="decimal" value={tolerance} onChange={(e) => setTolerance(e.target.value)} />
              </div>
              <div className="w-[160px]">
                <Label htmlFor="days">Date tolerance (days)</Label>
                <Input id="days" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} />
              </div>
              <Button variant="primary" onClick={() => void run()} loading={running} disabled={!left || !right || left === right}>
                <GitCompareArrows className="h-4 w-4" aria-hidden /> Run comparison
              </Button>
            </div>
            {err && (
              <Notice tone="danger" className="mt-3">
                {err}
              </Notice>
            )}
            {docs.data && options.length < 2 && <p className="mt-3 text-xs text-muted">Process at least two documents that contain invoices to compare them.</p>}
          </Panel>
          {selected ? (
            detail.isLoading ? (
              <Spinner label="Loading comparison" />
            ) : detail.error ? (
              <ErrorState error={detail.error} onRetry={() => detail.refetch()} />
            ) : detail.data ? (
              <Result rec={detail.data} />
            ) : null
          ) : (
            <Panel>
              <EmptyState icon={<GitCompareArrows className="h-8 w-8" />} title="Choose two documents to compare">
                The result lists matched invoices, invoices whose amounts, dates or names differ, and invoices that appear on one side only.
              </EmptyState>
            </Panel>
          )}
        </div>
        <Panel title="Previous comparisons" bodyClassName="p-0">
          {history.isLoading ? (
            <div className="px-4">
              <SkeletonRows rows={3} />
            </div>
          ) : !history.data?.length ? (
            <p className="px-4 py-6 text-sm text-muted">None yet.</p>
          ) : (
            <ul className="divide-y divide-line-soft">
              {history.data.map((h) => (
                <li key={h.id}>
                  <Link href={`/reconcile?id=${h.id}`} className={cn("block px-4 py-2.5 hover:bg-paper/50", selected === h.id && "bg-ledger-soft/60")}>
                    <span className="block truncate text-[13px] font-medium text-ink">
                      {h.left_filename} vs {h.right_filename}
                    </span>
                    <span className="num block text-xs text-muted">
                      {h.summary.matched} matched, {h.summary.mismatched} mismatched, {h.summary.missingInLeft + h.summary.missingInRight} unmatched
                    </span>
                    <span className="block text-xs text-faint">{dateTime(h.created_at)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </>
  );
}

export default function ReconcilePage() {
  return (
    <Suspense>
      <ReconcileInner />
    </Suspense>
  );
}
