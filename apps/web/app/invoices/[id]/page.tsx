"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Check, CornerDownLeft, Plus, Quote, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PageViewer, type Highlight } from "@/components/page-viewer";
import { parseCellRef, SheetGrid } from "@/components/sheet-grid";
import { Timeline } from "@/components/timeline";
import {
  Badge,
  Button,
  Confidence,
  ErrorState,
  InvoiceStatusBadge,
  Kbd,
  Notice,
  SeverityIcon,
  SourceTag,
  Spinner,
  Tabs,
} from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { cn, date, dateTime, decimalInput, FIELD_LABELS, ISSUE_LABELS, money, quantity } from "@/lib/format";
import { useDocumentPages, useInvoice, useInvoiceHistory, useRefreshAll } from "@/lib/queries";
import { FIELD_ORDER, type DocumentPage, type FieldName, type InvoiceDetail, type LineItem } from "@/lib/types";

const AMOUNT_FIELDS = new Set<FieldName>(["subtotal", "discount", "shipping", "tax", "total"]);
const DATE_FIELDS = new Set<FieldName>(["invoice_date", "due_date"]);

type Values = Record<FieldName, string>;
interface ItemRow {
  description: string;
  quantity: string;
  unit_price: string;
  amount: string;
}

function initialValues(inv: InvoiceDetail): Values {
  return Object.fromEntries(
    FIELD_ORDER.map((f) => {
      const v = inv.fields?.[f]?.value ?? null;
      return [f, v === null ? "" : AMOUNT_FIELDS.has(f) ? decimalInput(v) : v];
    }),
  ) as Values;
}

function initialItems(items: LineItem[]): ItemRow[] {
  return items.map((i) => ({
    description: i.description ?? "",
    quantity: quantity(i.quantity),
    unit_price: decimalInput(i.unit_price),
    amount: decimalInput(i.amount),
  }));
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** Find the page line that best contains an evidence quote (used when no bbox was stored). */
function locate(evidence: string, pages: DocumentPage[], preferPage?: number | null): Highlight | null {
  const target = norm(evidence);
  if (!target) return null;
  let best: { score: number; h: Highlight } | null = null;
  const tokens = target.split(" ").filter((t) => t.length > 1);
  for (const p of pages) {
    for (const line of p.lines ?? []) {
      const l = norm(line.text);
      if (!l) continue;
      let score = 0;
      if (l.includes(target) || target.includes(l)) score = 1 + Math.min(l.length, target.length) / Math.max(l.length, target.length);
      else {
        const hits = tokens.filter((t) => l.includes(t)).length;
        score = tokens.length ? hits / tokens.length : 0;
      }
      if (preferPage && p.page_number === preferPage) score += 0.05;
      if (score > 0.6 && (!best || score > best.score)) best = { score, h: { page: p.page_number, bbox: line.bbox } };
    }
  }
  return best?.h ?? null;
}

function useSourcePages(inv: InvoiceDetail | undefined) {
  const isSheet = !!inv && ["xlsx", "xls", "csv"].includes(inv.file_type ?? "");
  const from = isSheet ? 1 : inv?.page_start ?? 1;
  const to = isSheet ? inv?.page_count ?? 1 : inv?.page_end ?? inv?.page_start ?? 1;
  return { isSheet, from, to, ...useDocumentPages(inv?.document_id, from, to, !!inv) };
}

/* ------------------------------------------------------------------ issues */

function IssuesPanel({ inv, onFocusField }: { inv: InvoiceDetail; onFocusField: (f: string) => void }) {
  if (!inv.issues.length)
    return (
      <Notice tone="ok" className="mb-4">
        All validation checks passed.
      </Notice>
    );
  const order = { error: 0, warning: 1, info: 2 } as const;
  const sorted = [...inv.issues].sort((a, b) => order[a.severity] - order[b.severity]);
  return (
    <div className="mb-4 overflow-hidden rounded-lg border border-line bg-surface" data-testid="issues-panel">
      <div className="flex items-center justify-between border-b border-line-soft px-3 py-2">
        <h2 className="text-sm font-semibold">Validation</h2>
        <span className="num text-xs text-muted">
          {inv.issues.filter((i) => i.severity === "error").length} errors, {inv.issues.filter((i) => i.severity === "warning").length} warnings
        </span>
      </div>
      <ul className="max-h-[220px] divide-y divide-line-soft overflow-auto">
        {sorted.map((issue) => (
          <li key={issue.id}>
            <button
              type="button"
              onClick={() => issue.field && onFocusField(issue.field)}
              className={cn("flex w-full items-start gap-2 px-3 py-2 text-left text-[13px]", issue.field ? "hover:bg-paper/60" : "cursor-default")}
            >
              <SeverityIcon severity={issue.severity} className="mt-0.5" />
              <span className="min-w-0 flex-1">
                <span className="font-medium text-ink">{ISSUE_LABELS[issue.code] ?? issue.code.replace(/_/g, " ").toLowerCase()}</span>
                <span className="text-ink-soft">: {issue.message}</span>
              </span>
              {issue.field && <span className="shrink-0 text-xs text-ledger">{FIELD_LABELS[issue.field] ?? issue.field}</span>}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------ field ledger */

function FieldRow({
  name,
  inv,
  value,
  onChange,
  active,
  onFocus,
  hasIssue,
  onEnter,
}: {
  name: FieldName;
  inv: InvoiceDetail;
  value: string;
  onChange: (v: string) => void;
  active: boolean;
  onFocus: () => void;
  hasIssue: "error" | "warning" | null;
  onEnter: () => void;
}) {
  const field = inv.fields?.[name];
  const original = field?.value === null || field?.value === undefined ? "" : AMOUNT_FIELDS.has(name) ? decimalInput(field.value) : field.value;
  const changed = value !== original;
  const alternatives = (field?.alternatives ?? []).filter((a) => a.value && a.value !== value);
  return (
    <div
      className={cn(
        "grid grid-cols-[132px_minmax(0,1fr)] gap-x-3 border-l-[3px] px-3 py-2.5 transition-colors",
        active ? "border-l-highlight bg-highlight-soft/45" : "border-l-transparent",
      )}
      data-field={name}
    >
      <label htmlFor={`field-${name}`} className="pt-1.5 text-[13px] font-medium text-ink-soft">
        {FIELD_LABELS[name]}
        {hasIssue && <span className={cn("ml-1", hasIssue === "error" ? "text-danger" : "text-warn")} aria-label={hasIssue}>•</span>}
      </label>
      <div className="min-w-0">
        <input
          id={`field-${name}`}
          type={DATE_FIELDS.has(name) ? "date" : "text"}
          inputMode={AMOUNT_FIELDS.has(name) ? "decimal" : undefined}
          value={value}
          onChange={(e) => onChange(name === "currency" ? e.target.value.toUpperCase().slice(0, 3) : e.target.value)}
          onFocus={onFocus}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onEnter();
            }
          }}
          placeholder={field?.value ? "" : "Not found in the document"}
          className={cn("field-input", AMOUNT_FIELDS.has(name) && "num", changed && "border-[#d9a520] bg-highlight-soft/40", hasIssue === "error" && !changed && "border-danger/50")}
          aria-describedby={`ev-${name}`}
        />
        <div id={`ev-${name}`} className="mt-1.5 flex min-w-0 items-center gap-2 text-xs text-muted">
          {changed ? <Badge tone="highlight">Edited, not saved</Badge> : <SourceTag source={field?.source} />}
          {!changed && field?.value && <Confidence value={field.confidence} />}
          {field?.evidence?.text ? (
            <span className="flex min-w-0 items-center gap-1" title={field.evidence.text}>
              <Quote className="h-3 w-3 shrink-0 text-faint" aria-hidden />
              <span className="truncate">{field.evidence.text}</span>
            </span>
          ) : null}
        </div>
        {field?.note && <p className="mt-1 text-xs text-warn">{field.note}</p>}
        {alternatives.length > 0 && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
            <span className="text-muted">Other reading:</span>
            {alternatives.map((a) => (
              <button
                key={a.value}
                type="button"
                onClick={() => onChange(AMOUNT_FIELDS.has(name) ? decimalInput(a.value) : a.value)}
                className="rounded-full border border-line px-2 py-0.5 text-ink-soft hover:border-ledger hover:text-ledger"
                title={`Use the value read by ${a.source === "llm" ? "the AI" : a.source}`}
              >
                {AMOUNT_FIELDS.has(name) ? money(a.value) : a.value} <span className="text-faint">({a.source === "llm" ? "AI" : a.source})</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ line items */

function LineItemsEditor({
  items,
  setItems,
  subtotal,
  total,
  tax,
  currency,
  onFocusItem,
}: {
  items: ItemRow[];
  setItems: (rows: ItemRow[]) => void;
  subtotal: string;
  total: string;
  tax: string;
  currency: string;
  onFocusItem: (index: number) => void;
}) {
  const update = (i: number, key: keyof ItemRow, v: string) => setItems(items.map((r, k) => (k === i ? { ...r, [key]: v } : r)));
  const amounts = items.map((r) => Number(r.amount));
  const valid = items.length > 0 && items.every((r) => r.amount.trim() !== "" && Number.isFinite(Number(r.amount)));
  const sum = amounts.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  const target = subtotal ? Number(subtotal) : !tax && total ? Number(total) : null;
  const diff = target !== null && Number.isFinite(target) ? sum - target : null;
  const ok = diff !== null && Math.abs(diff) <= 0.05 + 0.01 * items.length;
  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm">
          <thead>
            <tr className="border-b border-line text-left text-[12px] text-muted">
              <th className="w-8 py-2 font-medium">#</th>
              <th className="py-2 pr-2 font-medium">Description</th>
              <th className="w-[80px] py-2 pr-2 text-right font-medium">Qty</th>
              <th className="w-[110px] py-2 pr-2 text-right font-medium">Unit price</th>
              <th className="w-[120px] py-2 pr-2 text-right font-medium">Amount</th>
              <th className="w-8" />
            </tr>
          </thead>
          <tbody className="divide-y divide-line-soft">
            {items.map((row, i) => {
              const q = Number(row.quantity);
              const p = Number(row.unit_price);
              const a = Number(row.amount);
              const mathOff = row.quantity && row.unit_price && row.amount && Number.isFinite(q * p) && Math.abs(q * p - a) > 0.02 + Math.abs(q) * 0.005;
              return (
                <tr key={i} onFocus={() => onFocusItem(i)}>
                  <td className="num py-1.5 text-xs text-muted">{i + 1}</td>
                  <td className="py-1.5 pr-2">
                    <input aria-label={`Line ${i + 1} description`} className="field-input" value={row.description} onChange={(e) => update(i, "description", e.target.value)} />
                  </td>
                  <td className="py-1.5 pr-2">
                    <input aria-label={`Line ${i + 1} quantity`} inputMode="decimal" className="field-input num text-right" value={row.quantity} onChange={(e) => update(i, "quantity", e.target.value)} />
                  </td>
                  <td className="py-1.5 pr-2">
                    <input aria-label={`Line ${i + 1} unit price`} inputMode="decimal" className="field-input num text-right" value={row.unit_price} onChange={(e) => update(i, "unit_price", e.target.value)} />
                  </td>
                  <td className="py-1.5 pr-2">
                    <input
                      aria-label={`Line ${i + 1} amount`}
                      inputMode="decimal"
                      className={cn("field-input num text-right", mathOff && "border-warn/60")}
                      value={row.amount}
                      onChange={(e) => update(i, "amount", e.target.value)}
                      title={mathOff ? "Quantity × unit price does not equal the amount" : undefined}
                    />
                  </td>
                  <td className="py-1.5 text-right">
                    <button type="button" className="rounded p-1 text-faint hover:bg-danger-soft hover:text-danger" onClick={() => setItems(items.filter((_, k) => k !== i))} aria-label={`Remove line ${i + 1}`}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!items.length && <p className="py-4 text-center text-sm text-muted">No line items were found. Add them if the invoice lists items.</p>}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <Button size="sm" onClick={() => setItems([...items, { description: "", quantity: "", unit_price: "", amount: "" }])}>
          <Plus className="h-3.5 w-3.5" aria-hidden /> Add line
        </Button>
        <div className="num text-right text-sm">
          <span className="text-muted">Items total </span>
          <span className="font-medium">{money(sum)}</span> <span className="text-xs text-muted">{currency}</span>
          {diff !== null && valid && (
            <span className={cn("ml-2 text-xs", ok ? "text-ok" : "text-danger")}>
              {ok ? `matches the ${subtotal ? "subtotal" : "total"}` : `${diff > 0 ? "+" : ""}${money(diff)} vs ${subtotal ? "subtotal" : "total"} ${money(target)}`}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ page */

export default function InvoiceReviewPage() {
  const { id } = useParams<{ id: string }>();
  const { data: inv, isLoading, error, refetch } = useInvoice(id);
  if (isLoading) return <Spinner label="Loading invoice" />;
  if (error || !inv) return <ErrorState error={error ?? new Error("Invoice not found")} onRetry={() => refetch()} />;
  // Remount per invoice so local edit state is initialised from the server copy exactly once.
  return <InvoiceEditor key={inv.id} initial={inv} />;
}

function InvoiceEditor({ initial }: { initial: InvoiceDetail }) {
  const id = initial.id;
  const qc = useQueryClient();
  const refreshAll = useRefreshAll();
  const { data, refetch } = useInvoice(id);
  const inv = data ?? initial;
  const source = useSourcePages(inv);
  const [values, setValues] = useState<Values>(() => initialValues(initial));
  const [items, setItems] = useState<ItemRow[]>(() => initialItems(initial.lineItems));
  const [reason, setReason] = useState("");
  const [active, setActive] = useState<FieldName | null>(null);
  const [activeItem, setActiveItem] = useState<number | null>(null);
  const [tab, setTab] = useState<"fields" | "items" | "history">("fields");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "danger" | "warn"; text: string; conflict?: boolean } | null>(null);
  const [approval, setApproval] = useState<{ mode: "idle" | "override" | "reject"; errors?: string[]; note: string }>({ mode: "idle", note: "" });
  const history = useInvoiceHistory(id, tab === "history");

  const reset = useCallback((d: InvoiceDetail) => {
    setValues(initialValues(d));
    setItems(initialItems(d.lineItems));
    setReason("");
  }, []);

  const original = useMemo(() => ({ values: initialValues(inv), items: initialItems(inv.lineItems) }), [inv]);
  const changedFields = useMemo(() => FIELD_ORDER.filter((f) => values[f] !== original.values[f]), [values, original]);
  const itemsChanged = useMemo(() => JSON.stringify(items) !== JSON.stringify(original.items), [items, original]);
  const dirty = changedFields.length > 0 || itemsChanged;

  const issueByField = useMemo(() => {
    const m = new Map<string, "error" | "warning">();
    for (const i of inv.issues) if (i.field && i.severity !== "info") m.set(i.field, m.get(i.field) === "error" ? "error" : (i.severity as "error" | "warning"));
    return m;
  }, [inv]);

  // Evidence highlight for the selected field or line item.
  const highlight = useMemo<Highlight | null>(() => {
    if (source.isSheet) return null;
    const pages = source.data?.items ?? [];
    if (activeItem !== null && tab === "items") {
      const li = inv.lineItems[activeItem];
      return li?.evidence ? locate(li.evidence, pages, li.page) : null;
    }
    if (!active) return null;
    const ev = inv.fields?.[active]?.evidence;
    if (!ev?.text) return null;
    if (ev.bbox && ev.page) return { page: ev.page, bbox: ev.bbox, label: FIELD_LABELS[active] };
    return locate(ev.text, pages, ev.page ?? inv.page_start);
  }, [inv, active, activeItem, tab, source.data, source.isSheet]);

  // The viewer follows the selected evidence; manual paging overrides it until the selection changes.
  const highlightKey = highlight ? `${highlight.page}:${highlight.bbox.join(",")}` : "none";
  const [manualPage, setManualPage] = useState<{ page: number; key: string } | null>(null);
  const page = manualPage && manualPage.key === highlightKey ? manualPage.page : highlight?.page ?? manualPage?.page ?? inv.page_start ?? 1;
  const setPage = (p: number) => setManualPage({ page: p, key: highlightKey });

  const cell = useMemo(() => {
    if (!source.isSheet || !active) return null;
    const ev = inv.fields?.[active]?.evidence;
    return parseCellRef(ev?.cell ?? ev?.text?.split(":")[0] ?? null);
  }, [inv, active, source.isSheet]);

  const focusField = (f: string) => {
    if (f === "line_items") {
      setTab("items");
      return;
    }
    setTab("fields");
    setTimeout(() => document.getElementById(`field-${f}`)?.focus(), 30);
  };

  const save = useCallback(async () => {
    if (!dirty) return;
    setSaving(true);
    setMessage(null);
    try {
      const body: Record<string, unknown> = { version: inv.version };
      if (changedFields.length) body.fields = Object.fromEntries(changedFields.map((f) => [f, values[f].trim() === "" ? null : values[f].trim()]));
      if (itemsChanged)
        body.lineItems = items.map((r) => ({
          description: r.description.trim() || null,
          quantity: r.quantity.trim() || null,
          unit_price: r.unit_price.trim() || null,
          amount: r.amount.trim() || null,
        }));
      if (reason.trim()) body.reason = reason.trim();
      const updated = await api<InvoiceDetail>(`/invoices/${inv.id}`, { method: "PATCH", json: body });
      qc.setQueryData(["invoice", inv.id], updated);
      reset(updated);
      refreshAll();
      const errors = updated.issues.filter((i) => i.severity === "error").length;
      setMessage({ tone: errors ? "warn" : "ok", text: errors ? `Saved. ${errors} validation error${errors > 1 ? "s" : ""} still open.` : "Saved. Validation re-ran and passed." });
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setMessage({ tone: "danger", text: e.message, conflict: true });
      else setMessage({ tone: "danger", text: e instanceof Error ? e.message : "Could not save." });
    } finally {
      setSaving(false);
    }
  }, [inv, values, items, dirty, changedFields, itemsChanged, reason, qc, reset, refreshAll]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

  const approve = async (override = false) => {
    setMessage(null);
    try {
      const updated = await api<InvoiceDetail>(`/invoices/${inv.id}/approve`, { method: "POST", json: override ? { override: true, note: approval.note.trim() } : {} });
      qc.setQueryData(["invoice", inv.id], updated);
      setApproval({ mode: "idle", note: "" });
      refreshAll();
      setMessage({ tone: "ok", text: override ? "Approved with override. The note is in the history." : "Approved." });
    } catch (e) {
      if (e instanceof ApiError && e.status === 422) {
        const errors = ((e.body as { errors?: string[] })?.errors ?? []) as string[];
        setApproval({ mode: "override", errors, note: "" });
      } else setMessage({ tone: "danger", text: e instanceof Error ? e.message : "Could not approve." });
    }
  };

  const reject = async () => {
    if (!approval.note.trim()) return;
    try {
      const updated = await api<InvoiceDetail>(`/invoices/${inv.id}/reject`, { method: "POST", json: { reason: approval.note.trim() } });
      qc.setQueryData(["invoice", inv.id], updated);
      setApproval({ mode: "idle", note: "" });
      refreshAll();
      setMessage({ tone: "warn", text: "Rejected. It will not be included in exports." });
    } catch (e) {
      setMessage({ tone: "danger", text: e instanceof Error ? e.message : "Could not reject." });
    }
  };

  const pages = Array.from({ length: Math.max(1, (inv.page_end ?? inv.page_start ?? 1) - (inv.page_start ?? 1) + 1) }, (_, i) => (inv.page_start ?? 1) + i);
  const sheetPage = source.isSheet ? source.data?.items.find((p) => p.sheet_name === (cell?.sheet ?? inv.sheet_name)) ?? source.data?.items[0] : null;

  return (
    <div className="pb-24">
      <nav className="mb-2 text-[13px] text-muted">
        <Link href="/review" className="hover:text-ink hover:underline">
          Review queue
        </Link>
        <span className="mx-1.5 text-faint">/</span>
        <Link href={`/documents/${inv.document_id}`} className="hover:text-ink hover:underline">
          {inv.filename}
        </Link>
      </nav>
      <header className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="heading text-[24px] leading-tight font-semibold">
            {inv.invoice_number ? `Invoice ${inv.invoice_number}` : "Invoice without a number"}
          </h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted">
            <InvoiceStatusBadge status={inv.status} />
            <span>{inv.supplier_name ?? "Unknown supplier"}</span>
            <span className="num">
              {money(inv.total)} {inv.currency ?? ""}
            </span>
            <span>
              Read by {inv.extraction_method === "hybrid" ? "rules and AI" : inv.extraction_method === "llm" ? "AI" : inv.extraction_method}
              {inv.llm_model ? ` (${inv.llm_model})` : ""}
            </span>
            {inv.is_corrected && <Badge tone="highlight">Corrected</Badge>}
            {inv.approved_by && (
              <span>
                Approved by {inv.approved_by}, {dateTime(inv.approved_at)}
              </span>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" onClick={() => setApproval({ mode: approval.mode === "reject" ? "idle" : "reject", note: "" })} disabled={inv.status === "rejected"}>
            <X className="h-4 w-4" aria-hidden /> Reject
          </Button>
          <Button onClick={() => void approve(false)} disabled={dirty || inv.status === "approved"} title={dirty ? "Save your corrections first" : undefined}>
            <Check className="h-4 w-4" aria-hidden /> Approve
          </Button>
          <Button variant="primary" onClick={() => void save()} loading={saving} disabled={!dirty} data-testid="save-corrections">
            Save corrections
          </Button>
        </div>
      </header>

      {message && (
        <Notice tone={message.tone} className="mb-4">
          {message.text}
          {message.conflict && (
            <Button
              size="sm"
              className="ml-3"
              onClick={async () => {
                const fresh = await refetch();
                if (fresh.data) reset(fresh.data);
                setMessage(null);
              }}
            >
              Reload latest version
            </Button>
          )}
        </Notice>
      )}
      {approval.mode === "override" && (
        <div className="mb-4 rounded-lg border border-danger/30 bg-danger-soft/50 p-4">
          <p className="text-sm font-medium text-danger">This invoice still has blocking validation errors.</p>
          <ul className="mt-1 list-disc pl-5 text-[13px] text-ink-soft">
            {(approval.errors ?? []).map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
          <p className="mt-2 text-[13px] text-ink-soft">Correct the values, or approve anyway with a note explaining why.</p>
          <textarea
            className="field-input mt-2 min-h-[64px]"
            placeholder="Why is it correct as is? (required)"
            value={approval.note}
            onChange={(e) => setApproval({ ...approval, note: e.target.value })}
          />
          <div className="mt-2 flex gap-2">
            <Button variant="danger" onClick={() => void approve(true)} disabled={!approval.note.trim()}>
              Approve anyway
            </Button>
            <Button variant="ghost" onClick={() => setApproval({ mode: "idle", note: "" })}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {approval.mode === "reject" && (
        <div className="mb-4 rounded-lg border border-line bg-surface p-4">
          <label htmlFor="reject-reason" className="text-sm font-medium">
            Reason for rejecting
          </label>
          <textarea
            id="reject-reason"
            className="field-input mt-2 min-h-[64px]"
            placeholder="For example: not our invoice, duplicate of an invoice paid in March"
            value={approval.note}
            onChange={(e) => setApproval({ ...approval, note: e.target.value })}
          />
          <div className="mt-2 flex gap-2">
            <Button variant="danger" onClick={() => void reject()} disabled={!approval.note.trim()}>
              Reject invoice
            </Button>
            <Button variant="ghost" onClick={() => setApproval({ mode: "idle", note: "" })}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1.08fr)_minmax(0,1fr)]">
        {/* source */}
        <div className="xl:sticky xl:top-5">
          {source.isSheet ? (
            <div className="rounded-lg border border-line bg-surface p-3">
              <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2 text-[13px]">
                <span className="font-medium">
                  Sheet {sheetPage?.sheet_name ?? inv.sheet_name}
                  {inv.row_start ? (inv.row_end && inv.row_end !== inv.row_start ? `, rows ${inv.row_start}–${inv.row_end}` : `, row ${inv.row_start}`) : ""}
                </span>
                <span className="text-muted">{active && inv.fields?.[active]?.evidence?.text ? `Selected: ${inv.fields[active].evidence!.text}` : "Select a field to see its source cell"}</span>
              </div>
              {source.isLoading ? <Spinner /> : sheetPage ? <SheetGrid text={sheetPage.text} tableData={sheetPage.table_data} highlight={cell} highlightRows={inv.row_start ? [inv.row_start, inv.row_end ?? inv.row_start] : null} maxHeight={640} /> : <p className="text-sm text-muted">Sheet not available.</p>}
            </div>
          ) : (
            <PageViewer documentId={inv.document_id} pages={pages} page={page} onPageChange={setPage} highlights={highlight ? [highlight] : []} />
          )}
          <p className="mt-2 text-xs text-muted">
            {source.isSheet ? "The highlighted cell is where the selected value was read." : "The amber box marks the line where the selected value was read."} Press <Kbd>Enter</Kbd> to move to the next field and{" "}
            <Kbd>⌘ S</Kbd> to save.
          </p>
        </div>

        {/* data */}
        <div className="min-w-0">
          <IssuesPanel inv={inv} onFocusField={focusField} />
          <Tabs
            value={tab}
            onChange={setTab}
            tabs={[
              { value: "fields", label: "Fields" },
              { value: "items", label: "Line items", count: items.length },
              { value: "history", label: "History", count: inv.corrections.length || undefined },
            ]}
          />
          <div className="mt-3 rounded-lg border border-line bg-surface">
            {tab === "fields" && (
              <div className="divide-y divide-line-soft" onBlur={() => undefined}>
                {FIELD_ORDER.map((f, i) => (
                  <FieldRow
                    key={f}
                    name={f}
                    inv={inv}
                    value={values[f]}
                    onChange={(v) => setValues({ ...values, [f]: v })}
                    active={active === f}
                    onFocus={() => {
                      setActive(f);
                      setActiveItem(null);
                    }}
                    hasIssue={issueByField.get(f) ?? null}
                    onEnter={() => document.getElementById(`field-${FIELD_ORDER[i + 1] ?? FIELD_ORDER[0]}`)?.focus()}
                  />
                ))}
              </div>
            )}
            {tab === "items" && (
              <div className="p-3">
                <LineItemsEditor
                  items={items}
                  setItems={setItems}
                  subtotal={values.subtotal}
                  total={values.total}
                  tax={values.tax}
                  currency={values.currency}
                  onFocusItem={(i) => {
                    setActiveItem(i);
                    setActive(null);
                  }}
                />
              </div>
            )}
            {tab === "history" && (
              <div className="space-y-5 p-4">
                <section>
                  <h3 className="mb-2 text-sm font-semibold">Corrections</h3>
                  {!inv.corrections.length ? (
                    <p className="text-sm text-muted">No manual corrections yet.</p>
                  ) : (
                    <ul className="space-y-2">
                      {inv.corrections.map((c, k) => (
                        <li key={k} className="rounded-md border border-line-soft px-3 py-2 text-[13px]">
                          <span className="font-medium">{FIELD_LABELS[c.field] ?? c.field}</span>{" "}
                          {c.field === "line_items" ? (
                            <span className="text-ink-soft">replaced</span>
                          ) : (
                            <>
                              <span className="text-muted line-through">{String(c.old_value ?? "empty")}</span> <CornerDownLeft className="inline h-3 w-3 rotate-180 text-faint" aria-hidden />{" "}
                              <span className="text-ink">{String(c.new_value ?? "empty")}</span>
                            </>
                          )}
                          <span className="block text-xs text-muted">
                            {c.actor}, {dateTime(c.created_at)}
                            {c.reason ? `: ${c.reason}` : ""}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
                <section>
                  <h3 className="mb-2 text-sm font-semibold">Activity</h3>
                  {history.isLoading ? <Spinner /> : <Timeline events={history.data?.events ?? []} />}
                </section>
                {inv.notes.length > 0 && (
                  <section>
                    <h3 className="mb-2 text-sm font-semibold">Extraction notes</h3>
                    <ul className="list-disc space-y-1 pl-5 text-[13px] text-ink-soft">
                      {inv.notes.map((n, k) => (
                        <li key={k}>{n}</li>
                      ))}
                    </ul>
                  </section>
                )}
              </div>
            )}
          </div>
          <p className="mt-3 text-xs text-muted">
            Invoice date {date(inv.invoice_date)}, extracted {dateTime(inv.created_at)}, version {inv.version}
            {inv.semanticIndexed ? ", indexed for search" : ""}.
          </p>
        </div>
      </div>

      {dirty && (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-surface/95 backdrop-blur md:left-[232px]">
          <div className="mx-auto flex max-w-[1440px] flex-wrap items-center gap-3 px-5 py-3 md:px-8">
            <span className="text-sm text-ink-soft">
              <span className="font-medium text-ink">Unsaved changes:</span>{" "}
              {[...changedFields.map((f) => FIELD_LABELS[f]), ...(itemsChanged ? ["line items"] : [])].join(", ")}
            </span>
            <input className="field-input h-8 min-w-[220px] flex-1" placeholder="Reason (optional, kept in the audit trail)" value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason for the correction" />
            <Button variant="ghost" onClick={() => reset(inv)}>
              Discard
            </Button>
            <Button variant="primary" onClick={() => void save()} loading={saving}>
              Save corrections
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
