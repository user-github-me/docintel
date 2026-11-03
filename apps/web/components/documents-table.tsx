"use client";

import { FileImage, FileSpreadsheet, FileText, RotateCw, Trash2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { ApiError } from "@/lib/api";
import { bytes, cn, duration, relative, STAGE_LABELS, typeLabel } from "@/lib/format";
import { isActive, useDeleteDocument, useReprocess } from "@/lib/queries";
import type { DocumentSummary } from "@/lib/types";
import { Button, ConfirmButton, DocumentStatusBadge, Progress } from "./ui";

export function FileIcon({ type, className }: { type: string | null; className?: string }) {
  const cls = cn("h-4 w-4 shrink-0", className);
  if (type === "image") return <FileImage className={cn(cls, "text-info")} aria-hidden />;
  if (type === "xlsx" || type === "xls" || type === "csv") return <FileSpreadsheet className={cn(cls, "text-ok")} aria-hidden />;
  return <FileText className={cn(cls, "text-ledger")} aria-hidden />;
}

function StatusCell({ d }: { d: DocumentSummary }) {
  if (isActive(d.status)) {
    return (
      <div className="min-w-[150px]">
        <div className="mb-1 flex items-center justify-between gap-2">
          <DocumentStatusBadge status={d.status} />
          <span className="num text-xs text-muted">{d.progress}%</span>
        </div>
        <Progress value={d.progress} />
        <p className="mt-1 truncate text-xs text-muted">
          {STAGE_LABELS[d.stage ?? "queued"] ?? d.stage}
          {d.pageCount && d.stage === "extract-text" ? `, page ${d.pagesProcessed} of ${d.pageCount}` : ""}
        </p>
      </div>
    );
  }
  if (d.status === "failed") {
    return (
      <div className="min-w-[150px]">
        <DocumentStatusBadge status={d.status} />
        <p className="mt-1 max-w-[260px] truncate text-xs text-danger" title={d.errorMessage ?? ""}>
          {(d.errorCode ?? "error").replace(/_/g, " ")}
        </p>
      </div>
    );
  }
  return <DocumentStatusBadge status={d.status} needsReview={d.needsReview} />;
}

function RowActions({ d }: { d: DocumentSummary }) {
  const reprocess = useReprocess();
  const remove = useDeleteDocument();
  const [needsForce, setNeedsForce] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const run = (force = false) =>
    reprocess.mutate(
      { id: d.id, force },
      {
        onError: (e) => {
          if (e instanceof ApiError && e.status === 409 && !force) setNeedsForce(true);
          else setErr(e.message);
        },
        onSuccess: () => {
          setNeedsForce(false);
          setErr(null);
        },
      },
    );
  return (
    <div className="flex items-center justify-end gap-1">
      {needsForce ? (
        <ConfirmButton prompt="Has corrections. Reprocess anyway?" confirmLabel="Reprocess" onConfirm={() => run(true)} variant="secondary">
          Confirm reprocess
        </ConfirmButton>
      ) : (
        d.status !== "duplicate" &&
        !isActive(d.status) && (
          <Button variant="ghost" size="sm" onClick={() => run()} loading={reprocess.isPending} title="Run extraction again">
            <RotateCw className="h-3.5 w-3.5" aria-hidden />
            <span className="sr-only md:not-sr-only">Reprocess</span>
          </Button>
        )
      )}
      <ConfirmButton prompt="Delete file and data?" confirmLabel="Delete" onConfirm={() => remove.mutate(d.id)} loading={remove.isPending}>
        <Trash2 className="h-3.5 w-3.5" aria-hidden />
        <span className="sr-only">Delete</span>
      </ConfirmButton>
      {err && <span className="text-xs text-danger">{err}</span>}
    </div>
  );
}

export function DocumentsTable({ documents, compact = false }: { documents: DocumentSummary[]; compact?: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] text-sm">
        <thead>
          <tr className="border-b border-line text-left text-[12px] text-muted">
            <th className="py-2 pr-3 font-medium">Document</th>
            <th className="py-2 pr-3 font-medium">Status</th>
            <th className="py-2 pr-3 text-right font-medium">Pages</th>
            <th className="py-2 pr-3 text-right font-medium">Invoices</th>
            {!compact && <th className="py-2 pr-3 text-right font-medium">Time</th>}
            <th className="py-2 pr-3 font-medium">Uploaded</th>
            {!compact && <th className="py-2 text-right font-medium">Actions</th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-line-soft">
          {documents.map((d) => (
            <tr key={d.id} className="align-top hover:bg-paper/50" data-testid="document-row">
              <td className="py-2.5 pr-3">
                <Link href={`/documents/${d.id}`} className="group flex min-w-0 items-start gap-2">
                  <FileIcon type={d.fileType} className="mt-0.5" />
                  <span className="min-w-0">
                    <span className="block max-w-[340px] truncate font-medium text-ink group-hover:underline">{d.filename}</span>
                    <span className="block text-xs text-muted">
                      {typeLabel(d.fileType, d.mimeType)}, {bytes(d.sizeBytes)}
                      {d.purpose === "reference" ? ", reference ledger" : ""}
                    </span>
                  </span>
                </Link>
              </td>
              <td className="py-2.5 pr-3">
                <StatusCell d={d} />
              </td>
              <td className="num py-2.5 pr-3 text-right text-ink-soft">
                {d.pageCount ?? "—"}
                {d.ocrPages > 0 && <span className="block text-xs text-muted">{d.ocrPages} OCR</span>}
              </td>
              <td className="num py-2.5 pr-3 text-right">{d.status === "completed" ? d.invoiceCount : "—"}</td>
              {!compact && <td className="num py-2.5 pr-3 text-right text-ink-soft">{d.status === "completed" ? duration(d.processingMs) : "—"}</td>}
              <td className="py-2.5 pr-3 text-ink-soft">
                <span title={d.createdAt}>{relative(d.createdAt)}</span>
              </td>
              {!compact && (
                <td className="py-2 text-right">
                  <RowActions d={d} />
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
