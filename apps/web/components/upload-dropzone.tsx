"use client";

import { CheckCircle2, FileUp, UploadCloud, XCircle } from "lucide-react";
import Link from "next/link";
import { useCallback, useRef, useState } from "react";
import { ApiError, uploadFiles } from "@/lib/api";
import { bytes, cn } from "@/lib/format";
import { useRefreshAll } from "@/lib/queries";
import type { UploadResponse } from "@/lib/types";
import { Button, Notice, Progress, Segmented } from "./ui";

const ACCEPT = ".pdf,.jpg,.jpeg,.png,.tif,.tiff,.xlsx,.xls,.csv";
const MAX_MB = 200;

export function UploadDropzone({ compact = false, grow = false }: { compact?: boolean; grow?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [purpose, setPurpose] = useState<"invoices" | "reference">("invoices");
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [result, setResult] = useState<UploadResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tooBig, setTooBig] = useState<string[]>([]);
  const refresh = useRefreshAll();

  const send = useCallback(
    async (list: FileList | File[]) => {
      const files = Array.from(list);
      if (!files.length) return;
      const big = files.filter((f) => f.size > MAX_MB * 1024 * 1024);
      setTooBig(big.map((f) => f.name));
      const ok = files.filter((f) => f.size <= MAX_MB * 1024 * 1024);
      setError(null);
      setResult(null);
      if (!ok.length) return;
      setProgress(0);
      try {
        const res = await uploadFiles(ok, purpose, setProgress);
        setResult(res);
        refresh();
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "Upload failed.");
      } finally {
        setProgress(null);
        if (input.current) input.current.value = "";
      }
    },
    [purpose, refresh],
  );

  return (
    <div className={cn(grow && "flex flex-1 flex-col")}>
      <div
        role="button"
        tabIndex={0}
        aria-label="Upload documents: drop files here or press Enter to choose files"
        onClick={() => input.current?.click()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            input.current?.click();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void send(e.dataTransfer.files);
        }}
        className={cn(
          "group relative flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed px-6 text-center transition-colors",
          compact ? "py-6" : "py-10",
          grow && "flex-1",
          dragging ? "border-ledger bg-ledger-soft/60" : "border-line bg-paper/40 hover:border-[#a9b8b4] hover:bg-paper/70",
        )}
      >
        <input
          ref={input}
          type="file"
          multiple
          accept={ACCEPT}
          className="sr-only"
          data-testid="file-input"
          onChange={(e) => e.target.files && void send(e.target.files)}
        />
        <UploadCloud className={cn("mb-2 h-8 w-8", dragging ? "text-ledger" : "text-faint group-hover:text-muted")} aria-hidden />
        <p className="text-[15px] font-medium text-ink">Drop invoices here, or choose files</p>
        <p className="mt-1 text-[13px] text-muted">PDF (scanned or digital), JPG, PNG, TIFF, Excel and CSV, up to {MAX_MB} MB each. Many files at once is fine.</p>
        {progress !== null && (
          <div className="mt-4 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <Progress value={progress * 100} />
            <p className="num mt-1 text-xs text-muted">Uploading… {Math.round(progress * 100)}%</p>
          </div>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Segmented
            label="Upload purpose"
            value={purpose}
            onChange={setPurpose}
            options={[
              { value: "invoices", label: "Invoices to process" },
              { value: "reference", label: "Reference ledger" },
            ]}
          />
        </div>
        <p className="text-xs text-muted">
          {purpose === "reference" ? "Ledgers and registers used only to cross-verify; never flagged as duplicates." : "Each file is read, extracted and validated in the background."}
        </p>
      </div>

      {error && (
        <Notice tone="danger" className="mt-3">
          {error}
        </Notice>
      )}
      {tooBig.length > 0 && (
        <Notice tone="warn" className="mt-3">
          Skipped (over {MAX_MB} MB): {tooBig.join(", ")}
        </Notice>
      )}
      {result && (
        <ul className="mt-3 divide-y divide-line-soft rounded-md border border-line-soft" data-testid="upload-result">
          {result.documents.map((d) => (
            <li key={d.id} className="flex items-center gap-2 px-3 py-2 text-sm">
              <CheckCircle2 className="h-4 w-4 shrink-0 text-ok" aria-hidden />
              <Link href={`/documents/${d.id}`} className="min-w-0 flex-1 truncate text-ink hover:underline">
                {d.filename}
              </Link>
              <span className="text-xs text-muted">{d.status === "duplicate" ? "Same file already uploaded; linked to the original" : `${bytes(d.sizeBytes)}, queued`}</span>
            </li>
          ))}
          {result.rejected.map((r) => (
            <li key={r.filename} className="flex items-center gap-2 px-3 py-2 text-sm">
              <XCircle className="h-4 w-4 shrink-0 text-danger" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{r.filename}</span>
              <span className="text-xs text-danger">{r.reason}</span>
            </li>
          ))}
        </ul>
      )}
      {!compact && !result && !error && (
        <div className="mt-3 hidden items-center gap-1.5 text-xs text-faint sm:flex">
          <FileUp className="h-3.5 w-3.5" aria-hidden /> Files are stored privately; the original stays available for audit.
        </div>
      )}
      <span className="sr-only" aria-live="polite">
        {result ? `${result.documents.length} uploaded, ${result.rejected.length} rejected` : ""}
      </span>
      {result && (
        <div className="mt-2 text-right">
          <Button variant="ghost" size="sm" onClick={() => setResult(null)}>
            Clear list
          </Button>
        </div>
      )}
    </div>
  );
}
