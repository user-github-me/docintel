"use client";

import { useEffect, useMemo, useRef } from "react";
import { cn } from "@/lib/format";

/** Parse the processor's sheet rendering ("Sheet: X\nR5: a | b | c") back into a grid. */
export function parseSheetText(text: string): { name: string; rows: Array<{ row: number; cells: string[] }>; cols: number } {
  const lines = text.split("\n");
  const name = lines[0]?.replace(/^Sheet:\s*/, "") ?? "";
  const rows: Array<{ row: number; cells: string[] }> = [];
  let cols = 0;
  for (const line of lines.slice(1)) {
    const m = /^R(\d+):\s?(.*)$/.exec(line);
    if (!m) continue;
    const cells = m[2].split(" | ");
    cols = Math.max(cols, cells.length);
    rows.push({ row: Number(m[1]), cells });
  }
  return { name, rows, cols };
}

/** Build the grid from the API's cell data (exact), falling back to parsing the text rendering. */
export function sheetGridFrom(text: string, tableData?: Array<Array<string | number | null>> | null) {
  if (!tableData?.length) return parseSheetText(text);
  const rows: Array<{ row: number; cells: string[] }> = [];
  let cols = 0;
  tableData.forEach((r, i) => {
    if (!r.some((c) => c !== null && c !== "")) return;
    const cells = r.map((c) => (c === null ? "" : String(c)));
    cols = Math.max(cols, cells.length);
    rows.push({ row: i + 1, cells });
  });
  return { name: text.split("\n")[0]?.replace(/^Sheet:\s*/, "") ?? "", rows, cols };
}

export function colLetter(c: number): string {
  let s = "";
  let n = c + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** "Invoices!C7" -> { sheet: "Invoices", col: 2, row: 7 } */
export function parseCellRef(ref: string | null | undefined): { sheet: string; col: number; row: number } | null {
  if (!ref) return null;
  const m = /^(.*)!([A-Z]+)(\d+)$/.exec(ref);
  if (!m) return null;
  let col = 0;
  for (const ch of m[2]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { sheet: m[1], col: col - 1, row: Number(m[3]) };
}

export function SheetGrid({
  text,
  tableData,
  highlight,
  highlightRows,
  maxHeight = 560,
}: {
  text: string;
  tableData?: Array<Array<string | number | null>> | null;
  highlight?: { col: number; row: number } | null;
  highlightRows?: [number, number] | null;
  maxHeight?: number;
}) {
  const grid = useMemo(() => sheetGridFrom(text, tableData), [text, tableData]);
  const box = useRef<HTMLDivElement>(null);
  const rangeStart = highlightRows?.[0];
  useEffect(() => {
    const container = box.current;
    const el = container?.querySelector<HTMLElement>("[data-active='true']") ?? container?.querySelector<HTMLElement>("[data-range='true']");
    if (!container || !el) return;
    const c = container.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    container.scrollTo({
      top: container.scrollTop + (r.top - c.top) - container.clientHeight / 2 + r.height / 2,
      left: container.scrollLeft + (r.left - c.left) - container.clientWidth / 2 + r.width / 2,
      behavior: "smooth",
    });
  }, [highlight?.col, highlight?.row, rangeStart]);
  if (!grid.rows.length) return <p className="py-6 text-center text-sm text-muted">This sheet is empty.</p>;
  return (
    <div ref={box} className="overflow-auto rounded-md border border-line" style={{ maxHeight }}>
      <table className="num min-w-full border-collapse text-[12.5px]">
        <thead className="sticky top-0 z-10">
          <tr className="bg-paper-deep text-muted">
            <th className="w-10 border-r border-b border-line px-2 py-1 text-right font-normal" />
            {Array.from({ length: grid.cols }).map((_, c) => (
              <th key={c} className={cn("border-r border-b border-line px-2 py-1 text-left font-normal", highlight?.col === c && "bg-highlight-soft text-ink")}>
                {colLetter(c)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {grid.rows.map((r) => {
            const inRange = highlightRows && r.row >= highlightRows[0] && r.row <= highlightRows[1];
            return (
              <tr key={r.row} className={cn(inRange && "bg-highlight-soft/50")} data-range={inRange && r.row === highlightRows?.[0] ? "true" : undefined}>
                <td className="sticky left-0 border-r border-b border-line bg-paper-deep px-2 py-1 text-right text-muted">{r.row}</td>
                {Array.from({ length: grid.cols }).map((_, c) => {
                  const active = highlight?.row === r.row && highlight?.col === c;
                  return (
                    <td
                      key={c}
                      data-active={active ? "true" : undefined}
                      className={cn("max-w-[280px] truncate border-r border-b border-line-soft px-2 py-1 text-ink", active && "bg-highlight/50 ring-2 ring-[#d9a520] ring-inset")}
                      title={r.cells[c] ?? ""}
                    >
                      {r.cells[c] ?? ""}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
