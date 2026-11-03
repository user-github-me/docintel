"use client";

import { ClipboardCheck, FileStack, GitCompareArrows, LayoutDashboard, Search } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/format";
import { useHealth, useStats } from "@/lib/queries";

const NAV = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/documents", label: "Documents", icon: FileStack },
  { href: "/review", label: "Review queue", icon: ClipboardCheck, badge: "review" as const },
  { href: "/search", label: "Search", icon: Search },
  { href: "/reconcile", label: "Cross-verify", icon: GitCompareArrows },
];

function Mark() {
  // A folded ledger page with a highlighter stroke: the product in one glyph.
  return (
    <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden>
      <path d="M5 3.5h11l5 5V22a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z" fill="#fff" stroke="#0f6e64" strokeWidth="1.6" />
      <path d="M16 3.5V8a.5.5 0 0 0 .5.5H21" fill="none" stroke="#0f6e64" strokeWidth="1.6" />
      <rect x="7" y="12.2" width="11" height="3.2" rx="1" fill="#f2c14e" />
      <path d="M7.5 18.5h9" stroke="#87939a" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M7.5 9.2h5" stroke="#87939a" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function SystemStatus() {
  const { data, isError } = useHealth();
  const items: Array<{ label: string; ok: boolean | null; detail: string }> = isError || !data
    ? [{ label: "API", ok: isError ? false : null, detail: isError ? "unreachable" : "checking" }]
    : [
        { label: "API & database", ok: data.database && data.queue, detail: data.database ? "connected" : "database down" },
        { label: "OCR processor", ok: data.processor.ok, detail: data.processor.ok ? `Tesseract ${data.processor.tesseract ?? ""}`.trim() : "unreachable" },
        { label: "AI extraction", ok: data.llm.enabled ? true : null, detail: data.llm.enabled ? `${data.llm.model ?? data.llm.provider}, ${data.llm.strategy} mode` : "off, rules only" },
        { label: "Semantic search", ok: data.processor.embedding?.loaded ?? null, detail: data.processor.embedding?.model?.split("/").pop() ?? "—" },
      ];
  return (
    <div className="space-y-2 border-t border-line px-4 py-4">
      <p className="text-[12px] font-medium text-muted">System</p>
      <ul className="space-y-1.5">
        {items.map((i) => (
          <li key={i.label} className="flex items-start gap-2 text-[12px] leading-tight">
            <span className={cn("mt-1 h-1.5 w-1.5 shrink-0 rounded-full", i.ok === true ? "bg-ok" : i.ok === false ? "bg-danger" : "bg-faint")} aria-hidden />
            <span className="min-w-0">
              <span className="text-ink-soft">{i.label}</span>
              <span className="block truncate text-faint" title={i.detail}>
                {i.detail}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Sidebar() {
  const pathname = usePathname();
  const { data: stats } = useStats();
  const review = stats?.invoices.needs_review ?? 0;
  return (
    <aside className="hidden w-[232px] shrink-0 border-r border-line bg-[#f6f8f7] md:block">
      <div className="sticky top-0 flex h-screen flex-col">
      <Link href="/" className="flex items-center gap-2.5 px-4 pt-5 pb-6">
        <Mark />
        <span className="leading-tight">
          <span className="heading block text-[17px] font-semibold text-ink">DocIntel</span>
          <span className="block text-[11.5px] text-muted">Invoice intelligence</span>
        </span>
      </Link>
      <nav className="flex-1 space-y-0.5 px-2" aria-label="Main">
        {NAV.map((item) => {
          const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "group flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[14px] transition-colors",
                active ? "bg-surface font-medium text-ink shadow-[0_0_0_1px_var(--color-line)]" : "text-ink-soft hover:bg-paper-deep/70 hover:text-ink",
              )}
            >
              <Icon className={cn("h-[18px] w-[18px]", active ? "text-ledger" : "text-faint group-hover:text-muted")} aria-hidden />
              <span className="flex-1">{item.label}</span>
              {item.badge === "review" && review > 0 && <span className="num rounded-full bg-highlight-soft px-1.5 text-xs font-medium text-[#7a5600]">{review}</span>}
            </Link>
          );
        })}
      </nav>
      <SystemStatus />
      </div>
    </aside>
  );
}

export function MobileNav() {
  const pathname = usePathname();
  return (
    <nav className="flex gap-1 overflow-x-auto border-b border-line bg-[#f6f8f7] px-3 py-2 md:hidden" aria-label="Main">
      {NAV.map((item) => {
        const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
        return (
          <Link key={item.href} href={item.href} className={cn("rounded-md px-2.5 py-1.5 text-[13px] whitespace-nowrap", active ? "bg-surface font-medium text-ink" : "text-ink-soft")}>
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
