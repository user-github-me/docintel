"use client";

import { ChevronLeft, ChevronRight, Minus, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { pageImageUrl } from "@/lib/api";
import { cn } from "@/lib/format";

export interface Highlight {
  page: number;
  bbox: number[]; // normalised x0, y0, x1, y1
  label?: string;
  tone?: "highlight" | "danger";
}

/**
 * Page image on a dark "light table", with evidence boxes drawn from normalised bounding boxes.
 * The amber box is the product's signature: it shows exactly where a value was read.
 */
export function PageViewer({
  documentId,
  pages,
  page,
  onPageChange,
  highlights = [],
  className,
  height = "calc(100vh - 210px)",
}: {
  documentId: string;
  pages: number[];
  page: number;
  onPageChange: (p: number) => void;
  highlights?: Highlight[];
  className?: string;
  height?: string;
}) {
  const [zoom, setZoom] = useState(1);
  const scroller = useRef<HTMLDivElement>(null);
  const imageKey = `${documentId}-${page}`;
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const loaded = loadedKey === imageKey;
  const failed = failedKey === imageKey;
  const idx = Math.max(0, pages.indexOf(page));
  const onPage = highlights.filter((h) => h.page === page);

  // Scroll the viewer (not the window) so the first highlight sits in the middle.
  useEffect(() => {
    const box = scroller.current;
    if (!loaded || !box) return;
    const el = box.querySelector<HTMLElement>('[data-highlight="0"]');
    if (!el) {
      box.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    const top = el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
    box.scrollTo({ top: Math.max(0, top - box.clientHeight / 2 + el.clientHeight / 2), behavior: "smooth" });
  }, [loaded, page, zoom, onPage.length, onPage[0]?.bbox?.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={cn("flex flex-col overflow-hidden rounded-lg border border-viewer-deep bg-viewer", className)} style={{ height }}>
      <div className="flex items-center justify-between gap-2 border-b border-white/10 px-3 py-2 text-[13px] text-white/80">
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="rounded p-1 hover:bg-white/10 disabled:opacity-30"
            onClick={() => onPageChange(pages[idx - 1])}
            disabled={idx <= 0}
            aria-label="Previous page"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="num min-w-[88px] text-center">
            Page {page}
            {pages.length > 1 ? ` of ${pages[pages.length - 1]}` : ""}
          </span>
          <button
            type="button"
            className="rounded p-1 hover:bg-white/10 disabled:opacity-30"
            onClick={() => onPageChange(pages[idx + 1])}
            disabled={idx >= pages.length - 1}
            aria-label="Next page"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
        <div className="flex items-center gap-1">
          <button type="button" className="rounded p-1 hover:bg-white/10" onClick={() => setZoom((z) => Math.max(0.6, +(z - 0.2).toFixed(1)))} aria-label="Zoom out">
            <Minus className="h-4 w-4" />
          </button>
          <span className="num w-12 text-center">{Math.round(zoom * 100)}%</span>
          <button type="button" className="rounded p-1 hover:bg-white/10" onClick={() => setZoom((z) => Math.min(2.6, +(z + 0.2).toFixed(1)))} aria-label="Zoom in">
            <Plus className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div ref={scroller} className="flex-1 overflow-auto p-4">
        <div className="relative mx-auto" style={{ width: `${zoom * 100}%`, maxWidth: zoom <= 1 ? 860 : undefined }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            key={imageKey}
            src={pageImageUrl(documentId, page)}
            alt={`Page ${page} of the uploaded document`}
            className={cn("block w-full rounded-sm bg-white shadow-[0_8px_30px_rgba(0,0,0,0.35)] transition-opacity", loaded ? "opacity-100" : "opacity-0")}
            onLoad={() => setLoadedKey(imageKey)}
            onError={() => setFailedKey(imageKey)}
            draggable={false}
          />
          {!loaded && !failed && <div className="absolute inset-0 min-h-[400px] animate-pulse rounded-sm bg-white/5" aria-hidden />}
          {failed && <p className="py-20 text-center text-sm text-white/70">The page image could not be rendered.</p>}
          {loaded &&
            onPage.map((h, i) => {
              const [x0, y0, x1, y1] = h.bbox;
              const pad = 0.004;
              return (
                <div
                  key={i}
                  data-highlight={i}
                  className={cn(
                    "pointer-events-none absolute rounded-[3px] mix-blend-multiply",
                    h.tone === "danger" ? "bg-danger/25 ring-2 ring-danger/70" : "bg-highlight/45 ring-2 ring-[#d9a520]",
                  )}
                  style={{ left: `${(x0 - pad) * 100}%`, top: `${(y0 - pad) * 100}%`, width: `${(x1 - x0 + pad * 2) * 100}%`, height: `${(y1 - y0 + pad * 2) * 100}%` }}
                  title={h.label}
                />
              );
            })}
        </div>
      </div>
    </div>
  );
}
