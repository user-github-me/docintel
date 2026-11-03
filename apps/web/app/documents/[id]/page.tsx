"use client";

import { AlertTriangle, Download, RotateCw, Trash2 } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { FileIcon } from "@/components/documents-table";
import { PageViewer } from "@/components/page-viewer";
import { SheetGrid } from "@/components/sheet-grid";
import { Timeline, type TimelineEvent } from "@/components/timeline";
import {
  Button,
  buttonClass,
  ConfirmButton,
  DocumentStatusBadge,
  EmptyState,
  ErrorState,
  InvoiceStatusBadge,
  KeyValue,
  Notice,
  Panel,
  Progress,
  SeverityIcon,
  Spinner,
  Tabs,
} from "@/components/ui";
import { ApiError, fileUrl } from "@/lib/api";
import { bytes, cn, date, dateTime, duration, ISSUE_LABELS, money, percent, STAGE_LABELS, typeLabel } from "@/lib/format";
import { isActive, useDeleteDocument, useDocument, useDocumentEvents, useDocumentPages, useReprocess } from "@/lib/queries";
import type { DocumentDetail } from "@/lib/types";

const FAILURE_HELP: Record<string, string> = {
  corrupted_file: "The file is damaged or is not really the type its name says. Export or scan it again and upload the new copy.",
  encrypted_pdf: "The PDF is password protected. Remove the password (print to PDF) and upload it again.",
  empty_file: "The file is empty. Check the source and upload it again.",
  unsupported_format: "This file type is not supported. Use PDF, JPG, PNG, TIFF, XLSX, XLS or CSV.",
  too_many_pages: "The PDF is larger than the page limit. Split it and upload the parts.",
  image_too_large: "The image resolution is too large to process safely. Downscale it and upload again.",
  file_too_large: "The file expands to an unsafe size. Re-save it and upload again.",
};

function Header({ doc }: { doc: DocumentDetail }) {
  const router = useRouter();
  const reprocess = useReprocess();
  const remove = useDeleteDocument();
  const [force, setForce] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const run = (f = false) =>
    reprocess.mutate(
      { id: doc.id, force: f },
      {
        onError: (e) => (e instanceof ApiError && e.status === 409 && !f ? setForce(true) : setErr(e.message)),
        onSuccess: () => {
          setForce(false);
          setErr(null);
        },
      },
    );
  const active = isActive(doc.status);
  return (
    <header className="mb-5">
      <nav className="mb-2 text-[13px] text-muted">
        <Link href="/documents" className="hover:text-ink hover:underline">
          Documents
        </Link>
        <span className="mx-1.5 text-faint">/</span>
        <span className="text-ink-soft">{doc.filename}</span>
      </nav>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <FileIcon type={doc.fileType} className="mt-1.5 h-6 w-6" />
          <div className="min-w-0">
            <h1 className="heading truncate text-[24px] leading-tight font-semibold">{doc.filename}</h1>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <DocumentStatusBadge status={doc.status} needsReview={doc.needsReview} />
              {active && <span className="text-[13px] text-muted">{STAGE_LABELS[doc.stage ?? "queued"] ?? doc.stage}</span>}
              {doc.purpose === "reference" && <span className="text-[13px] text-muted">Reference ledger (cross-verification only)</span>}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <a href={fileUrl(doc.id)} className={buttonClass("secondary")}>
            <Download className="h-4 w-4" aria-hidden /> Original file
          </a>
          {force ? (
            <ConfirmButton prompt="This removes manual corrections. Continue?" confirmLabel="Reprocess" onConfirm={() => run(true)} variant="secondary" size="md">
              Confirm reprocess
            </ConfirmButton>
          ) : (
            doc.status !== "duplicate" && (
              <Button onClick={() => run()} loading={reprocess.isPending} disabled={active}>
                <RotateCw className="h-4 w-4" aria-hidden /> Reprocess
              </Button>
            )
          )}
          <ConfirmButton prompt="Delete this document and its data?" confirmLabel="Delete" size="md" onConfirm={() => remove.mutate(doc.id, { onSuccess: () => router.push("/documents") })}>
            <Trash2 className="h-4 w-4" aria-hidden /> Delete
          </ConfirmButton>
        </div>
      </div>
      {err && (
        <Notice tone="danger" className="mt-3">
          {err}
        </Notice>
      )}
      {active && (
        <div className="mt-4 max-w-xl">
          <Progress value={doc.progress} />
          <p className="num mt-1 text-xs text-muted">
            {doc.progress}% {doc.pageCount ? `, ${doc.pagesProcessed} of ${doc.pageCount} pages read` : ""}
          </p>
        </div>
      )}
    </header>
  );
}

function Facts({ doc }: { doc: DocumentDetail }) {
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-6">
      <KeyValue label="Type">{typeLabel(doc.fileType, doc.mimeType)}, {bytes(doc.sizeBytes)}</KeyValue>
      <KeyValue label={doc.fileType && ["xlsx", "xls", "csv"].includes(doc.fileType) ? "Sheets" : "Pages"}>
        <span className="num">{doc.pageCount ?? "—"}</span>
        {doc.ocrPages > 0 && <span className="text-muted"> ({doc.ocrPages} OCR)</span>}
      </KeyValue>
      <KeyValue label="OCR confidence">{doc.avgOcrConfidence !== null ? <span className="num">{percent(doc.avgOcrConfidence)}</span> : "Not needed"}</KeyValue>
      <KeyValue label="Processing time">
        <span className="num">{duration(doc.processingMs)}</span>
      </KeyValue>
      <KeyValue label="AI calls">
        <span className="num">{doc.llm.calls}</span>
        {doc.llm.calls > 0 && <span className="text-muted"> ({(doc.llm.inputTokens + doc.llm.outputTokens).toLocaleString()} tokens)</span>}
      </KeyValue>
      <KeyValue label="Uploaded">
        {dateTime(doc.createdAt)}
        {doc.uploadedBy && <span className="text-muted"> by {doc.uploadedBy}</span>}
      </KeyValue>
    </dl>
  );
}

function InvoicesTab({ doc }: { doc: DocumentDetail }) {
  if (doc.status !== "completed")
    return <EmptyState title={doc.status === "failed" ? "No invoices: processing failed" : "Invoices appear here when processing finishes"}>{doc.status === "failed" ? "Fix the file and reprocess it." : "This usually takes a few seconds per page."}</EmptyState>;
  if (!doc.invoices.length) return <EmptyState title="No invoice found in this document">It may be a cover letter, terms page or an unreadable scan. Check the pages tab.</EmptyState>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[760px] text-sm">
        <thead>
          <tr className="border-b border-line text-left text-[12px] text-muted">
            <th className="py-2 pr-3 font-medium">#</th>
            <th className="py-2 pr-3 font-medium">Invoice</th>
            <th className="py-2 pr-3 font-medium">Supplier</th>
            <th className="py-2 pr-3 font-medium">Date</th>
            <th className="py-2 pr-3 text-right font-medium">Total</th>
            <th className="py-2 pr-3 font-medium">Location</th>
            <th className="py-2 pr-3 font-medium">Status</th>
            <th className="py-2 font-medium">Issues</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line-soft">
          {doc.invoices.map((inv) => (
            <tr key={inv.id} className="hover:bg-paper/50">
              <td className="num py-2.5 pr-3 text-muted">{inv.sequence}</td>
              <td className="py-2.5 pr-3">
                <Link href={`/invoices/${inv.id}`} className="font-medium text-ink hover:underline" data-testid="invoice-link">
                  {inv.invoice_number ?? <span className="text-danger">No number</span>}
                </Link>
              </td>
              <td className="max-w-[240px] truncate py-2.5 pr-3 text-ink-soft">{inv.supplier_name ?? "—"}</td>
              <td className="num py-2.5 pr-3 text-ink-soft">{date(inv.invoice_date)}</td>
              <td className="num py-2.5 pr-3 text-right">
                {money(inv.total)} <span className="text-xs text-muted">{inv.currency ?? ""}</span>
              </td>
              <td className="py-2.5 pr-3 text-xs text-muted">
                {inv.sheet_name ? `${inv.sheet_name}, row ${inv.row_start ?? "?"}` : inv.page_start ? (inv.page_end && inv.page_end !== inv.page_start ? `Pages ${inv.page_start}–${inv.page_end}` : `Page ${inv.page_start}`) : "—"}
              </td>
              <td className="py-2.5 pr-3">
                <InvoiceStatusBadge status={inv.status} />
              </td>
              <td className="num py-2.5 text-xs">
                {inv.errors > 0 && <span className="mr-2 text-danger">{inv.errors} error{inv.errors > 1 ? "s" : ""}</span>}
                {inv.warnings > 0 && <span className="text-warn">{inv.warnings} warning{inv.warnings > 1 ? "s" : ""}</span>}
                {!inv.errors && !inv.warnings && <span className="text-faint">None</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OverviewTab({ doc, events, onShowHistory }: { doc: DocumentDetail; events: TimelineEvent[]; onShowHistory: () => void }) {
  const isSheet = !!doc.fileType && ["xlsx", "xls", "csv"].includes(doc.fileType);
  const total = Math.max(1, doc.pageCount ?? 1);
  const [page, setPage] = useState(1);
  const [sheet, setSheet] = useState(1);
  const sheets = useDocumentPages(doc.id, 1, total, isSheet && doc.status === "completed");
  const pages = Array.from({ length: total }, (_, i) => i + 1);
  const canView = doc.status === "completed" || doc.pagesProcessed > 0;
  return (
    <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
      <div className="min-w-0">
        {!canView ? (
          <Panel>
            <EmptyState title={doc.status === "failed" ? "The file could not be read" : "Pages appear as soon as they are read"}>{doc.status === "failed" ? "See the error above." : "Reading usually takes a few seconds per page."}</EmptyState>
          </Panel>
        ) : isSheet ? (
          <div className="rounded-lg border border-line bg-surface p-3">
            <div className="mb-2 flex flex-wrap gap-1.5">
              {(sheets.data?.items ?? []).map((s) => (
                <button
                  key={s.page_number}
                  type="button"
                  onClick={() => setSheet(s.page_number)}
                  className={cn("rounded-md border px-2.5 py-1 text-[13px]", sheet === s.page_number ? "border-ledger bg-ledger-soft text-ledger-dark" : "border-line text-ink-soft hover:border-[#b9c5c2]")}
                >
                  {s.sheet_name ?? `Sheet ${s.page_number}`}
                </button>
              ))}
            </div>
            {sheets.isLoading ? <Spinner /> : <SheetGrid text={sheets.data?.items.find((s) => s.page_number === sheet)?.text ?? ""} tableData={sheets.data?.items.find((s) => s.page_number === sheet)?.table_data} maxHeight={620} />}
          </div>
        ) : (
          <PageViewer documentId={doc.id} pages={pages} page={page} onPageChange={setPage} height="680px" />
        )}
      </div>
      <div className="min-w-0 space-y-5">
        <Panel title="Invoices found" description={doc.status === "completed" ? `${doc.invoices.length} in this document` : undefined} bodyClassName="p-0">
          {doc.status !== "completed" ? (
            <p className="px-4 py-6 text-sm text-muted">{doc.status === "failed" ? "None: processing failed." : "Extraction runs after all pages are read."}</p>
          ) : !doc.invoices.length ? (
            <p className="px-4 py-6 text-sm text-muted">No invoice was identified in this document.</p>
          ) : (
            <ul className="max-h-[360px] divide-y divide-line-soft overflow-auto">
              {doc.invoices.map((inv) => (
                <li key={inv.id} className="flex items-center gap-3 px-4 py-2.5 hover:bg-paper/50">
                  <div className="min-w-0 flex-1">
                    <Link href={`/invoices/${inv.id}`} className="block truncate text-sm font-medium text-ink hover:underline" data-testid="invoice-link">
                      {inv.invoice_number ?? "No invoice number"}
                    </Link>
                    <span className="block truncate text-xs text-muted">
                      {inv.supplier_name ?? "Unknown supplier"}, {date(inv.invoice_date)}
                    </span>
                  </div>
                  {inv.page_start && !isSheet ? (
                    <button type="button" className="text-xs text-ledger hover:underline" onClick={() => setPage(inv.page_start!)}>
                      {inv.page_end && inv.page_end !== inv.page_start ? `Pages ${inv.page_start}–${inv.page_end}` : `Page ${inv.page_start}`}
                    </button>
                  ) : inv.sheet_name ? (
                    <span className="text-xs text-muted">Row {inv.row_start}</span>
                  ) : null}
                  <span className="num w-[120px] text-right text-sm">
                    {money(inv.total)} <span className="text-xs text-muted">{inv.currency ?? ""}</span>
                  </span>
                  <InvoiceStatusBadge status={inv.status} />
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel title="Processing history" actions={<Button size="sm" variant="ghost" onClick={onShowHistory}>Full history</Button>}>
          <Timeline events={events.slice(-8)} />
        </Panel>
      </div>
    </div>
  );
}

function PagesTab({ doc }: { doc: DocumentDetail }) {
  const isSheet = !!doc.fileType && ["xlsx", "xls", "csv"].includes(doc.fileType);
  const total = doc.pageCount ?? 1;
  const [page, setPage] = useState(1);
  const window = useMemo(() => ({ from: Math.max(1, page - 5), to: Math.min(total, page + 5) }), [page, total]);
  const { data, isLoading, error } = useDocumentPages(doc.id, isSheet ? 1 : window.from, isSheet ? total : window.to, doc.status === "completed" || doc.pagesProcessed > 0);
  const current = data?.items.find((p) => p.page_number === page);
  if (isLoading) return <Spinner label="Loading pages" />;
  if (error) return <ErrorState error={error} />;
  if (!data?.items.length) return <EmptyState title="No pages read yet">Pages appear here as soon as they are processed.</EmptyState>;
  if (isSheet) {
    return (
      <div className="space-y-6">
        {data.items.map((s) => (
          <section key={s.page_number}>
            <h3 className="mb-2 text-sm font-semibold">
              Sheet: {s.sheet_name ?? s.page_number}
            </h3>
            <SheetGrid text={s.text} tableData={s.table_data} />
          </section>
        ))}
      </div>
    );
  }
  const pages = Array.from({ length: total }, (_, i) => i + 1);
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
      <PageViewer documentId={doc.id} pages={pages} page={page} onPageChange={setPage} height="760px" />
      <div className="flex min-h-0 flex-col rounded-lg border border-line" style={{ height: 760 }}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line-soft px-3 py-2 text-[13px]">
          <span className="font-medium">Extracted text</span>
          {current && (
            <span className="text-muted">
              {current.kind === "ocr" ? `OCR, ${percent(current.ocr_confidence)} confidence` : current.kind === "text" ? "From the PDF text layer" : current.kind}
              {current.duration_ms ? `, ${duration(current.duration_ms)}` : ""}
            </span>
          )}
        </div>
        {current?.ocr_steps?.length ? <p className="border-b border-line-soft px-3 py-1.5 text-xs text-muted">Clean-up applied: {current.ocr_steps.join(", ")}</p> : null}
        <pre className="num flex-1 overflow-auto px-3 py-2 text-[11.5px] leading-[1.45] whitespace-pre text-ink-soft">{current?.text || "No text on this page."}</pre>
      </div>
    </div>
  );
}

export default function DocumentPage() {
  const { id } = useParams<{ id: string }>();
  const { data: doc, isLoading, error, refetch } = useDocument(id);
  const events = useDocumentEvents(id, isActive(doc?.status));
  const [chosenTab, setTab] = useState<"overview" | "invoices" | "pages" | "activity" | null>(null);
  const tab = chosenTab ?? (doc?.status === "failed" ? "activity" : "overview");

  if (isLoading) return <Spinner label="Loading document" />;
  if (error || !doc) return <ErrorState error={error ?? new Error("Document not found")} onRetry={() => refetch()} />;
  const isSheet = !!doc.fileType && ["xlsx", "xls", "csv"].includes(doc.fileType);
  return (
    <>
      <Header doc={doc} />
      {doc.status === "failed" && (
        <Notice tone="danger" className="mb-4">
          <p className="font-medium text-danger">Processing failed: {(doc.errorCode ?? "error").replace(/_/g, " ")}</p>
          <p className="mt-0.5">{doc.errorMessage}</p>
          {doc.errorCode && FAILURE_HELP[doc.errorCode] && <p className="mt-1 text-ink">{FAILURE_HELP[doc.errorCode]}</p>}
        </Notice>
      )}
      {doc.status === "duplicate" && doc.duplicateOf && (
        <Notice tone="info" className="mb-4">
          This file is byte-for-byte identical to an earlier upload, so it was not processed again.{" "}
          <Link href={`/documents/${doc.duplicateOf}`} className="font-medium text-ledger underline">
            Open the original
          </Link>
        </Notice>
      )}
      {doc.warnings.length > 0 && (
        <Notice tone="warn" className="mb-4">
          {doc.warnings.map((w) => w.replace(/_/g, " ")).join("; ")}
        </Notice>
      )}
      <Panel className="mb-5">
        <Facts doc={doc} />
      </Panel>
      {doc.documentIssues.length > 0 && (
        <div className="mb-5 space-y-2">
          {doc.documentIssues.map((i, k) => (
            <div key={k} className="flex items-start gap-2 rounded-md border border-line bg-surface px-3 py-2 text-sm">
              <SeverityIcon severity={i.severity} className="mt-0.5" />
              <span>
                <span className="font-medium">{ISSUE_LABELS[i.code] ?? i.code}.</span> {i.message}
              </span>
            </div>
          ))}
        </div>
      )}
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: "overview", label: "Overview" },
          { value: "invoices", label: "Invoices", count: doc.invoices.length },
          { value: "pages", label: isSheet ? "Sheets" : "Pages and text", count: doc.pageCount ?? undefined },
          { value: "activity", label: "Processing history" },
        ]}
      />
      <div className="mt-4">
        {tab === "overview" && <OverviewTab doc={doc} events={events.data?.items ?? []} onShowHistory={() => setTab("activity")} />}
        {tab === "invoices" && (
          <Panel bodyClassName="px-4 py-2">
            <InvoicesTab doc={doc} />
          </Panel>
        )}
        {tab === "pages" && <PagesTab doc={doc} />}
        {tab === "activity" && (
          <Panel>
            {events.isLoading ? <Spinner /> : events.error ? <ErrorState error={events.error} /> : <Timeline events={events.data?.items ?? []} />}
          </Panel>
        )}
      </div>
      {doc.correctionCount > 0 && (
        <p className={cn("mt-4 flex items-center gap-1.5 text-xs text-muted")}>
          <AlertTriangle className="h-3.5 w-3.5" aria-hidden /> {doc.correctionCount} manual correction{doc.correctionCount > 1 ? "s" : ""} recorded on this document.
        </p>
      )}
    </>
  );
}
