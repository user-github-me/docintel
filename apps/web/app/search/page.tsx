"use client";

import { Search, SlidersHorizontal } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { FileIcon } from "@/components/documents-table";
import { InvoicesTable } from "@/components/invoices-table";
import { Badge, Button, EmptyState, ErrorState, Input, InvoiceStatusBadge, Label, Panel, PageHeader, Segmented, Select, SkeletonRows, Tabs } from "@/components/ui";
import { cn, date, money } from "@/lib/format";
import { useInvoices, useSearch, type InvoiceFilters } from "@/lib/queries";

type Mode = "hybrid" | "keyword" | "semantic";
interface Filters {
  status: string;
  supplier: string;
  currency: string;
  dateFrom: string;
  dateTo: string;
  minTotal: string;
  maxTotal: string;
}
const EMPTY: Filters = { status: "", supplier: "", currency: "", dateFrom: "", dateTo: "", minTotal: "", maxTotal: "" };
const EXAMPLES = ["home nursing visit", "physiotherapy sessions", "wheelchair rental", "office supplies", "INV-2026"];

/** Render ts_headline output ("<b>term</b>") as React text, never as HTML. */
function Snippet({ text }: { text: string }) {
  const segments: Array<{ text: string; bold: boolean }> = [];
  let bold = false;
  for (const part of text.replace(/<\/b>(\s+)<b>/g, "$1").split(/(<b>|<\/b>)/g)) {
    if (part === "<b>") bold = true;
    else if (part === "</b>") bold = false;
    else if (part) segments.push({ text: part.replace(/\s+/g, " "), bold });
  }
  return (
    <p className="mt-1.5 line-clamp-2 text-[13px] text-ink-soft">
      {segments.map((seg, i) =>
        seg.bold ? (
          <mark key={i} className="rounded-[2px] bg-highlight-soft px-0.5 text-ink">
            {seg.text}
          </mark>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </p>
  );
}

function FilterFields({ value, onChange }: { value: Filters; onChange: (f: Filters) => void }) {
  const set = (k: keyof Filters, v: string) => onChange({ ...value, [k]: v });
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-7">
      <div>
        <Label htmlFor="f-status">Status</Label>
        <Select id="f-status" value={value.status} onChange={(e) => set("status", e.target.value)}>
          <option value="">Any</option>
          <option value="needs_review">Needs review</option>
          <option value="validated">Validated</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
        </Select>
      </div>
      <div className="lg:col-span-2">
        <Label htmlFor="f-supplier">Supplier</Label>
        <Input id="f-supplier" placeholder="Any supplier" value={value.supplier} onChange={(e) => set("supplier", e.target.value)} />
      </div>
      <div>
        <Label htmlFor="f-currency">Currency</Label>
        <Select id="f-currency" value={value.currency} onChange={(e) => set("currency", e.target.value)}>
          <option value="">Any</option>
          {["USD", "EUR", "GBP", "BDT", "INR", "CAD", "AUD"].map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </Select>
      </div>
      <div>
        <Label htmlFor="f-from">From</Label>
        <Input id="f-from" type="date" value={value.dateFrom} onChange={(e) => set("dateFrom", e.target.value)} />
      </div>
      <div>
        <Label htmlFor="f-to">To</Label>
        <Input id="f-to" type="date" value={value.dateTo} onChange={(e) => set("dateTo", e.target.value)} />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label htmlFor="f-min">Min total</Label>
          <Input id="f-min" inputMode="decimal" placeholder="0" value={value.minTotal} onChange={(e) => set("minTotal", e.target.value.replace(/[^\d.]/g, ""))} />
        </div>
        <div>
          <Label htmlFor="f-max">Max total</Label>
          <Input id="f-max" inputMode="decimal" placeholder="Any" value={value.maxTotal} onChange={(e) => set("maxTotal", e.target.value.replace(/[^\d.]/g, ""))} />
        </div>
      </div>
    </div>
  );
}

function clean(f: Filters): Partial<Filters> {
  return Object.fromEntries(Object.entries(f).filter(([, v]) => v !== "")) as Partial<Filters>;
}

function SearchTab() {
  const params = useSearchParams();
  const router = useRouter();
  const [text, setText] = useState(params.get("q") ?? "");
  const [mode, setMode] = useState<Mode>((params.get("mode") as Mode) || "hybrid");
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [showFilters, setShowFilters] = useState(false);
  const [submitted, setSubmitted] = useState<{ q: string; mode: Mode; filters: Filters } | null>(params.get("q") ? { q: params.get("q")!, mode: (params.get("mode") as Mode) || "hybrid", filters: EMPTY } : null);
  const { data, isFetching, error, refetch } = useSearch({ q: submitted?.q, mode: submitted?.mode, limit: 25, ...(submitted ? clean(submitted.filters) : {}) }, !!submitted?.q);

  const run = (q = text, m = mode) => {
    if (!q.trim()) return;
    setSubmitted({ q: q.trim(), mode: m, filters });
    router.replace(`/search?q=${encodeURIComponent(q.trim())}&mode=${m}`, { scroll: false });
  };
  const activeFilters = Object.values(filters).filter(Boolean).length;

  return (
    <>
      <form
        className="rounded-lg border border-line bg-surface p-4"
        onSubmit={(e) => {
          e.preventDefault();
          run();
        }}
      >
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-[260px] flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-faint" aria-hidden />
            <input
              autoFocus
              className="field-input h-11 pl-9 text-[15px]"
              placeholder="Search by meaning or keyword: supplier, invoice number, service, amount"
              value={text}
              onChange={(e) => setText(e.target.value)}
              aria-label="Search query"
            />
          </div>
          <Segmented
            label="Search mode"
            value={mode}
            onChange={(m) => {
              setMode(m);
              if (submitted) run(text, m);
            }}
            options={[
              { value: "hybrid", label: "Hybrid" },
              { value: "keyword", label: "Keyword" },
              { value: "semantic", label: "Semantic" },
            ]}
          />
          <Button type="button" variant="ghost" onClick={() => setShowFilters((v) => !v)} aria-expanded={showFilters}>
            <SlidersHorizontal className="h-4 w-4" aria-hidden /> Filters{activeFilters ? ` (${activeFilters})` : ""}
          </Button>
          <Button type="submit" variant="primary" className="h-11 px-5">
            Search
          </Button>
        </div>
        <p className="mt-2 text-xs text-muted">
          {mode === "hybrid"
            ? "Hybrid combines exact keyword matches with meaning-based matches, ranked together."
            : mode === "keyword"
              ? "Keyword finds exact words and invoice numbers in extracted fields and page text."
              : "Semantic finds invoices about the same thing even when the words differ."}
        </p>
        {showFilters && (
          <div className="mt-4 border-t border-line-soft pt-4">
            <FilterFields value={filters} onChange={setFilters} />
          </div>
        )}
      </form>

      <div className="mt-5">
        {!submitted ? (
          <Panel>
            <EmptyState icon={<Search className="h-8 w-8" />} title="Search everything that has been processed">
              <span className="mt-2 flex flex-wrap justify-center gap-1.5">
                {EXAMPLES.map((ex) => (
                  <button
                    key={ex}
                    type="button"
                    className="rounded-full border border-line px-2.5 py-1 text-[13px] text-ink-soft hover:border-ledger hover:text-ledger"
                    onClick={() => {
                      setText(ex);
                      run(ex);
                    }}
                  >
                    {ex}
                  </button>
                ))}
              </span>
            </EmptyState>
          </Panel>
        ) : error ? (
          <ErrorState error={error} onRetry={() => refetch()} />
        ) : !data && isFetching ? (
          <SkeletonRows rows={6} />
        ) : data && !data.results.length ? (
          <Panel>
            <EmptyState title={`No matches for "${data.query}"`}>Try another wording, switch to semantic mode, or remove filters.</EmptyState>
          </Panel>
        ) : data ? (
          <>
            <p className="num mb-2 text-[13px] text-muted">
              {data.results.length} result{data.results.length === 1 ? "" : "s"} in {data.tookMs} ms
              {data.embeddingModel ? `, semantic model ${data.embeddingModel.split("/").pop()}` : ""}
              {isFetching ? ", updating" : ""}
            </p>
            <ul className={cn("divide-y divide-line-soft rounded-lg border border-line bg-surface", isFetching && "opacity-70")} data-testid="search-results">
              {data.results.map((r) => (
                <li key={r.invoice.id}>
                  <Link href={`/invoices/${r.invoice.id}`} className="flex gap-4 px-4 py-3 hover:bg-paper/50">
                    <FileIcon type={r.invoice.file_type} className="mt-1" />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className="font-medium text-ink">{r.invoice.supplier_name ?? "Unknown supplier"}</span>
                        <span className="text-[13px] text-muted">{r.invoice.invoice_number ?? "no number"}</span>
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                        <span>{r.invoice.customer_name ? `Billed to ${r.invoice.customer_name}` : "Customer not found"}</span>
                        <span>{date(r.invoice.invoice_date)}</span>
                        <span className="truncate">
                          {r.invoice.filename}
                          {r.page ? `, page ${r.page}` : ""}
                        </span>
                      </div>
                      {r.snippet && <Snippet text={r.snippet} />}
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1.5">
                      <span className="num text-sm font-medium">
                        {money(r.invoice.total)} <span className="text-xs font-normal text-muted">{r.invoice.currency ?? ""}</span>
                      </span>
                      <InvoiceStatusBadge status={r.invoice.status} />
                      <span className="flex gap-1">
                        {r.matchedBy.map((m) => (
                          <Badge key={m} tone={m === "semantic" ? "info" : "neutral"} className="font-normal">
                            {m === "semantic" ? "Meaning" : "Keyword"}
                          </Badge>
                        ))}
                      </span>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </div>
    </>
  );
}

const SORTS: Record<string, { sort: InvoiceFilters["sort"]; order: InvoiceFilters["order"]; label: string }> = {
  newest: { sort: "created_at", order: "desc", label: "Recently extracted" },
  date: { sort: "invoice_date", order: "desc", label: "Invoice date, newest" },
  total: { sort: "total", order: "desc", label: "Largest total" },
  confidence: { sort: "confidence", order: "asc", label: "Lowest confidence" },
};

function BrowseTab() {
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [keyword, setKeyword] = useState("");
  const [sortKey, setSortKey] = useState("newest");
  const [page, setPage] = useState(1);
  const pageSize = 25;
  const s = SORTS[sortKey];
  const { data, isLoading, error, refetch } = useInvoices({ ...clean(filters), q: keyword || undefined, sort: s.sort, order: s.order, page, pageSize });
  return (
    <>
      <div className="rounded-lg border border-line bg-surface p-4">
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <div className="min-w-[240px] flex-1">
            <Label htmlFor="b-q">Keyword</Label>
            <Input id="b-q" placeholder="Invoice number, name or item" value={keyword} onChange={(e) => { setKeyword(e.target.value); setPage(1); }} />
          </div>
          <div className="w-[220px]">
            <Label htmlFor="b-sort">Sort</Label>
            <Select id="b-sort" value={sortKey} onChange={(e) => setSortKey(e.target.value)}>
              {Object.entries(SORTS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v.label}
                </option>
              ))}
            </Select>
          </div>
        </div>
        <FilterFields value={filters} onChange={(f) => { setFilters(f); setPage(1); }} />
      </div>
      <Panel className="mt-5" bodyClassName="px-4 py-2">
        {isLoading ? (
          <SkeletonRows rows={8} />
        ) : error ? (
          <div className="py-3">
            <ErrorState error={error} onRetry={() => refetch()} />
          </div>
        ) : !data?.items.length ? (
          <EmptyState title="No invoices match">Remove a filter or upload more documents.</EmptyState>
        ) : (
          <InvoicesTable rows={data.items} />
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

function SearchInner() {
  const [tab, setTab] = useState<"search" | "browse">("search");
  return (
    <>
      <PageHeader title="Search" description="Find any processed invoice by supplier, number, service, amount or meaning, or browse every extracted invoice with filters." />
      <div className="mb-4">
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { value: "search", label: "Search" },
            { value: "browse", label: "Browse all invoices" },
          ]}
        />
      </div>
      {tab === "search" ? <SearchTab /> : <BrowseTab />}
    </>
  );
}

export default function SearchPage() {
  return (
    <Suspense>
      <SearchInner />
    </Suspense>
  );
}
