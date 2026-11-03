"use client";

import { FileStack, RotateCw, Search } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { DocumentsTable } from "@/components/documents-table";
import { UploadDropzone } from "@/components/upload-dropzone";
import { Button, EmptyState, ErrorState, Input, Notice, Panel, PageHeader, Select, SkeletonRows } from "@/components/ui";
import { useDocuments, useRetryFailed } from "@/lib/queries";

function DocumentsInner() {
  const router = useRouter();
  const params = useSearchParams();
  const [status, setStatus] = useState(params.get("status") ?? "");
  const [fileType, setFileType] = useState(params.get("fileType") ?? "");
  const [review, setReview] = useState(params.get("needsReview") ?? "");
  const [q, setQ] = useState(params.get("q") ?? "");
  const [query, setQuery] = useState(q);
  const [page, setPage] = useState(1);
  const [showUpload, setShowUpload] = useState(false);
  const pageSize = 20;
  const retry = useRetryFailed();

  useEffect(() => {
    const t = setTimeout(() => {
      setQuery(q.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    const u = new URLSearchParams();
    if (status) u.set("status", status);
    if (fileType) u.set("fileType", fileType);
    if (review) u.set("needsReview", review);
    if (query) u.set("q", query);
    router.replace(`/documents${u.toString() ? `?${u}` : ""}`, { scroll: false });
  }, [status, fileType, review, query, router]);

  const { data, isLoading, error, refetch, isFetching } = useDocuments({
    status: status || undefined,
    fileType: fileType || undefined,
    needsReview: review ? review === "true" : undefined,
    q: query || undefined,
    page,
    pageSize,
  });
  const pages = data ? Math.max(1, Math.ceil(data.total / pageSize)) : 1;

  return (
    <>
      <PageHeader
        title="Documents"
        description="Every uploaded file with its processing state. Open a document to see its pages, extracted invoices and processing history."
        actions={
          <>
            <Button onClick={() => retry.mutate()} loading={retry.isPending} title="Reprocess all failed documents except permanently broken files">
              <RotateCw className="h-4 w-4" aria-hidden /> Retry failed
            </Button>
            <Button variant="primary" onClick={() => setShowUpload((v) => !v)}>
              {showUpload ? "Hide upload" : "Upload documents"}
            </Button>
          </>
        }
      />
      {retry.data && (
        <Notice tone="ok" className="mb-4">
          Requeued {retry.data.retried} document{retry.data.retried === 1 ? "" : "s"}
          {retry.data.skipped ? `; ${retry.data.skipped} skipped because the file itself is corrupt, encrypted or unsupported.` : "."}
        </Notice>
      )}
      {showUpload && (
        <Panel className="mb-5">
          <UploadDropzone compact />
        </Panel>
      )}
      <Panel bodyClassName="p-0">
        <div className="flex flex-wrap items-end gap-3 border-b border-line-soft px-4 py-3">
          <div className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-faint" aria-hidden />
            <Input aria-label="Filter by file name" placeholder="Filter by file name" value={q} onChange={(e) => setQ(e.target.value)} className="pl-8" />
          </div>
          <Select aria-label="Status" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="w-[170px]">
            <option value="">All statuses</option>
            <option value="queued">Queued</option>
            <option value="processing">Reading</option>
            <option value="analyzing">Extracting</option>
            <option value="completed">Completed</option>
            <option value="failed">Failed</option>
            <option value="duplicate">Duplicate upload</option>
          </Select>
          <Select aria-label="File type" value={fileType} onChange={(e) => { setFileType(e.target.value); setPage(1); }} className="w-[150px]">
            <option value="">All file types</option>
            <option value="pdf">PDF</option>
            <option value="image">Image</option>
            <option value="xlsx">Excel</option>
            <option value="xls">Excel 97</option>
            <option value="csv">CSV</option>
          </Select>
          <Select aria-label="Review state" value={review} onChange={(e) => { setReview(e.target.value); setPage(1); }} className="w-[170px]">
            <option value="">Any review state</option>
            <option value="true">Needs review</option>
            <option value="false">No review needed</option>
          </Select>
        </div>
        <div className="px-4 pb-2">
          {isLoading ? (
            <SkeletonRows rows={8} />
          ) : error ? (
            <div className="py-4">
              <ErrorState error={error} onRetry={() => refetch()} />
            </div>
          ) : !data?.items.length ? (
            <EmptyState icon={<FileStack className="h-8 w-8" />} title={status || fileType || query || review ? "No documents match these filters" : "No documents yet"}>
              {status || fileType || query || review ? "Clear a filter to see more." : "Upload PDFs, scans, photos, Excel or CSV files to start."}
            </EmptyState>
          ) : (
            <DocumentsTable documents={data.items} />
          )}
        </div>
        {data && data.total > pageSize && (
          <div className="flex items-center justify-between border-t border-line-soft px-4 py-3 text-sm text-muted">
            <span className="num">
              {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, data.total)} of {data.total}
              {isFetching && ", updating"}
            </span>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => setPage((p) => p - 1)} disabled={page <= 1}>
                Previous
              </Button>
              <Button size="sm" onClick={() => setPage((p) => p + 1)} disabled={page >= pages}>
                Next
              </Button>
            </div>
          </div>
        )}
      </Panel>
    </>
  );
}

export default function DocumentsPage() {
  return (
    <Suspense>
      <DocumentsInner />
    </Suspense>
  );
}
