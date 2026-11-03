"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { cn, date, money, relative } from "@/lib/format";
import type { InvoiceListRow } from "@/lib/types";
import { Confidence, InvoiceStatusBadge } from "./ui";

export function InvoicesTable({ rows, showIssues = true, showStatus = true }: { rows: InvoiceListRow[]; showIssues?: boolean; showStatus?: boolean }) {
  const router = useRouter();
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[820px] table-fixed text-sm">
        <colgroup>
          <col className="w-[26%]" />
          <col className="w-[17%]" />
          <col className="w-[10%]" />
          <col className="w-[13%]" />
          {showStatus && <col className="w-[11%]" />}
          {showIssues && <col className="w-[12%]" />}
          <col className="w-[9%]" />
          <col className="w-[13%]" />
        </colgroup>
        <thead>
          <tr className="border-b border-line text-left text-[12px] text-muted">
            <th className="py-2 pr-3 font-medium">Supplier and invoice</th>
            <th className="py-2 pr-3 font-medium">Customer</th>
            <th className="py-2 pr-3 font-medium">Date</th>
            <th className="py-2 pr-3 text-right font-medium">Total</th>
            {showStatus && <th className="py-2 pr-3 font-medium">Status</th>}
            {showIssues && <th className="py-2 pr-3 font-medium">Issues</th>}
            <th className="py-2 pr-3 font-medium">Confidence</th>
            <th className="py-2 font-medium">Source</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line-soft">
          {rows.map((r) => (
            <tr key={r.id} className="cursor-pointer hover:bg-paper/50" onClick={() => router.push(`/invoices/${r.id}`)} data-testid="invoice-row">
              <td className="py-2.5 pr-3">
                <Link href={`/invoices/${r.id}`} className="block truncate font-medium text-ink hover:underline" onClick={(e) => e.stopPropagation()}>
                  {r.supplier_name ?? "Unknown supplier"}
                </Link>
                <span className={cn("block truncate text-xs", r.invoice_number ? "text-muted" : "text-danger")}>{r.invoice_number ?? "No invoice number"}</span>
              </td>
              <td className="truncate py-2.5 pr-3 text-ink-soft" title={r.customer_name ?? ""}>{r.customer_name ?? "—"}</td>
              <td className="num py-2.5 pr-3 whitespace-nowrap text-ink-soft">{date(r.invoice_date)}</td>
              <td className="num py-2.5 pr-3 text-right whitespace-nowrap">
                {money(r.total)} <span className="text-xs text-muted">{r.currency ?? ""}</span>
              </td>
              {showStatus && (
                <td className="py-2.5 pr-3">
                  <InvoiceStatusBadge status={r.status} />
                </td>
              )}
              {showIssues && (
                <td className="num py-2.5 pr-3 text-xs whitespace-nowrap">
                  {r.errors > 0 && <span className="mr-2 text-danger">{r.errors} error{r.errors > 1 ? "s" : ""}</span>}
                  {r.warnings > 0 && <span className="text-warn">{r.warnings} warning{r.warnings > 1 ? "s" : ""}</span>}
                  {!r.errors && !r.warnings && <span className="text-faint">None</span>}
                </td>
              )}
              <td className="py-2.5 pr-3">
                <Confidence value={r.confidence} />
              </td>
              <td className="py-2.5 text-xs text-muted">
                <span className="block truncate" title={r.filename}>{r.filename}</span>
                <span className="block truncate">
                  {r.sheet_name ? `${r.sheet_name} sheet` : r.page_start ? `page ${r.page_start}` : ""}
                  {r.created_at ? `, ${relative(r.created_at)}` : ""}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
