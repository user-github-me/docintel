"use client";

import { AlertCircle, AlertTriangle, CheckCircle2, ChevronDown, Info, Loader2, RotateCw } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/format";
import type { DocumentStatus, InvoiceStatus, Severity } from "@/lib/types";

/* ------------------------------------------------------------------ buttons */

type Variant = "primary" | "secondary" | "ghost" | "danger" | "quiet";
type Size = "sm" | "md";

export function buttonClass(variant: Variant = "secondary", size: Size = "md") {
  return cn(
    "inline-flex items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-50",
    size === "sm" ? "h-7 px-2.5 text-[13px]" : "h-9 px-3.5 text-sm",
    variant === "primary" && "bg-ledger text-white hover:bg-ledger-dark shadow-[inset_0_-1px_0_rgba(0,0,0,0.15)]",
    variant === "secondary" && "border border-line bg-surface text-ink hover:border-[#b9c5c2] hover:bg-paper/60",
    variant === "ghost" && "text-ink-soft hover:bg-paper-deep/70 hover:text-ink",
    variant === "quiet" && "text-ledger hover:text-ledger-dark hover:underline underline-offset-2 px-0 h-auto",
    variant === "danger" && "border border-danger/30 bg-surface text-danger hover:bg-danger-soft",
  );
}

export function Button({
  variant = "secondary",
  size = "md",
  loading,
  className,
  children,
  ...props
}: React.ComponentProps<"button"> & { variant?: Variant; size?: Size; loading?: boolean }) {
  return (
    <button className={cn(buttonClass(variant, size), className)} disabled={loading || props.disabled} {...props}>
      {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
      {children}
    </button>
  );
}

export function ButtonLink({ href, variant = "secondary", size = "md", className, children }: { href: string; variant?: Variant; size?: Size; className?: string; children: React.ReactNode }) {
  return (
    <Link href={href} className={cn(buttonClass(variant, size), className)}>
      {children}
    </Link>
  );
}

/* ------------------------------------------------------------------ badges */

type Tone = "neutral" | "ok" | "warn" | "danger" | "info" | "ledger" | "highlight";

const TONES: Record<Tone, string> = {
  neutral: "bg-paper-deep text-ink-soft",
  ok: "bg-ok-soft text-ok",
  warn: "bg-warn-soft text-warn",
  danger: "bg-danger-soft text-danger",
  info: "bg-info-soft text-info",
  ledger: "bg-ledger-soft text-ledger-dark",
  highlight: "bg-highlight-soft text-[#7a5600]",
};

export function Badge({ tone = "neutral", children, className, title }: { tone?: Tone; children: React.ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap", TONES[tone], className)}>
      {children}
    </span>
  );
}

const DOC_STATUS: Record<DocumentStatus, { tone: Tone; label: string }> = {
  queued: { tone: "neutral", label: "Queued" },
  processing: { tone: "info", label: "Processing" },
  analyzing: { tone: "info", label: "Extracting" },
  completed: { tone: "ok", label: "Completed" },
  failed: { tone: "danger", label: "Failed" },
  duplicate: { tone: "neutral", label: "Duplicate upload" },
};

export function DocumentStatusBadge({ status, needsReview }: { status: DocumentStatus; needsReview?: boolean }) {
  if (status === "completed" && needsReview) return <Badge tone="warn">Needs review</Badge>;
  const s = DOC_STATUS[status] ?? { tone: "neutral" as Tone, label: status };
  return (
    <Badge tone={s.tone}>
      {(status === "processing" || status === "analyzing") && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}
      {s.label}
    </Badge>
  );
}

const INV_STATUS: Record<InvoiceStatus, { tone: Tone; label: string }> = {
  needs_review: { tone: "warn", label: "Needs review" },
  validated: { tone: "ledger", label: "Validated" },
  approved: { tone: "ok", label: "Approved" },
  rejected: { tone: "danger", label: "Rejected" },
};

export function InvoiceStatusBadge({ status }: { status: InvoiceStatus }) {
  const s = INV_STATUS[status] ?? { tone: "neutral" as Tone, label: status };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

export function SeverityIcon({ severity, className }: { severity: Severity; className?: string }) {
  if (severity === "error") return <AlertCircle className={cn("h-4 w-4 shrink-0 text-danger", className)} aria-label="Error" />;
  if (severity === "warning") return <AlertTriangle className={cn("h-4 w-4 shrink-0 text-warn", className)} aria-label="Warning" />;
  return <Info className={cn("h-4 w-4 shrink-0 text-info", className)} aria-label="Info" />;
}

/** Quiet confidence indicator: a short bar plus the percentage, coloured by threshold. */
export function Confidence({ value, className }: { value: number | null | undefined; className?: string }) {
  if (value === null || value === undefined || value <= 0) return <span className={cn("text-xs text-faint", className)}>—</span>;
  const pct = Math.round(value * 100);
  const tone = value >= 0.85 ? "bg-ok" : value >= 0.65 ? "bg-highlight" : "bg-danger";
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)} title={`Extraction confidence ${pct}%`}>
      <span className="relative h-1.5 w-10 overflow-hidden rounded-full bg-line-soft">
        <span className={cn("absolute inset-y-0 left-0 rounded-full", tone)} style={{ width: `${Math.max(6, pct)}%` }} />
      </span>
      <span className="num text-xs text-muted">{pct}%</span>
    </span>
  );
}

const SOURCE_LABELS: Record<string, { label: string; tone: Tone; title: string }> = {
  rules: { label: "Rules", tone: "neutral", title: "Read by the deterministic layout rules" },
  llm: { label: "AI", tone: "info", title: "Read by the language model and verified against the document" },
  "rules+llm": { label: "Rules + AI agree", tone: "ledger", title: "Rules and the language model independently read the same value" },
  spreadsheet: { label: "Spreadsheet", tone: "neutral", title: "Taken from a mapped spreadsheet column" },
  manual: { label: "Corrected", tone: "highlight", title: "Entered by a reviewer" },
  none: { label: "Not found", tone: "neutral", title: "No value found in the document" },
};

export function SourceTag({ source }: { source: string | null | undefined }) {
  const s = SOURCE_LABELS[source ?? "none"] ?? SOURCE_LABELS.none;
  return (
    <Badge tone={s.tone} title={s.title} className="font-normal">
      {s.label}
    </Badge>
  );
}

/* ------------------------------------------------------------------ layout */

export function PageHeader({ title, description, actions, children }: { title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="heading text-[26px] leading-tight font-semibold text-ink">{title}</h1>
        {description && <p className="mt-1 max-w-[72ch] text-[14px] text-muted">{description}</p>}
        {children}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function Panel({
  title,
  description,
  actions,
  children,
  className,
  bodyClassName,
  id,
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  id?: string;
}) {
  return (
    <section id={id} className={cn("rounded-lg border border-line bg-surface", className)}>
      {(title || actions) && (
        <div className="flex items-start justify-between gap-3 border-b border-line-soft px-4 py-3">
          <div className="min-w-0">
            {title && <h2 className="text-[15px] font-semibold text-ink">{title}</h2>}
            {description && <p className="mt-0.5 text-[13px] text-muted">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className={cn("p-4", bodyClassName)}>{children}</div>
    </section>
  );
}

export function Progress({ value, tone = "ledger", className }: { value: number; tone?: "ledger" | "danger" | "ok"; className?: string }) {
  const color = tone === "danger" ? "bg-danger" : tone === "ok" ? "bg-ok" : "bg-ledger";
  return (
    <div className={cn("h-1.5 w-full overflow-hidden rounded-full bg-line-soft", className)} role="progressbar" aria-valuenow={Math.round(value)} aria-valuemin={0} aria-valuemax={100}>
      <div className={cn("h-full rounded-full transition-[width] duration-500 ease-out", color)} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
    </div>
  );
}

export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 py-8 text-sm text-muted" role="status">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> {label}…
    </div>
  );
}

export function SkeletonRows({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-2 py-2" aria-hidden>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-9 animate-pulse rounded-md bg-paper-deep/70" />
      ))}
    </div>
  );
}

export function EmptyState({ icon, title, children, action }: { icon?: React.ReactNode; title: string; children?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      {icon && <div className="mb-3 text-faint">{icon}</div>}
      <p className="text-[15px] font-medium text-ink">{title}</p>
      {children && <div className="mt-1 max-w-[52ch] text-sm text-muted">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof Error ? error.message : "Something went wrong.";
  const status = (error as { status?: number })?.status;
  return (
    <div className="flex items-start gap-3 rounded-lg border border-danger/25 bg-danger-soft/60 px-4 py-3 text-sm">
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-danger">{status === 404 ? "Not found" : status === 401 ? "Not authorised" : "Could not load data"}</p>
        <p className="mt-0.5 text-ink-soft">{message}</p>
      </div>
      {onRetry && (
        <Button size="sm" onClick={onRetry}>
          <RotateCw className="h-3.5 w-3.5" aria-hidden /> Retry
        </Button>
      )}
    </div>
  );
}

export function Notice({ tone = "info", children, className }: { tone?: "info" | "ok" | "warn" | "danger"; children: React.ReactNode; className?: string }) {
  const Icon = tone === "ok" ? CheckCircle2 : tone === "danger" ? AlertCircle : tone === "warn" ? AlertTriangle : Info;
  const color = tone === "ok" ? "text-ok bg-ok-soft border-ok/20" : tone === "danger" ? "text-danger bg-danger-soft border-danger/20" : tone === "warn" ? "text-warn bg-warn-soft border-warn/20" : "text-info bg-info-soft border-info/20";
  return (
    <div className={cn("flex items-start gap-2 rounded-md border px-3 py-2 text-sm", color, className)} role={tone === "danger" ? "alert" : "status"}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1 text-ink-soft">{children}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ inputs */

export function Segmented<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: Array<{ value: T; label: React.ReactNode }>; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-md border border-line bg-paper p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "rounded-[5px] px-3 py-1 text-[13px] font-medium transition-colors",
            value === o.value ? "bg-surface text-ink shadow-[0_1px_2px_rgba(29,43,54,0.12)]" : "text-muted hover:text-ink",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Select({ className, children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className={cn("relative inline-block", className ?? "w-full")}>
      <select className="field-input h-9 w-full appearance-none pr-8" {...props}>
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute top-1/2 right-2.5 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden />
    </span>
  );
}

export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn("field-input h-9", className)} {...props} />;
}

export function Label({ children, htmlFor, className }: { children: React.ReactNode; htmlFor?: string; className?: string }) {
  return (
    <label htmlFor={htmlFor} className={cn("mb-1 block text-[13px] font-medium text-ink-soft", className)}>
      {children}
    </label>
  );
}

/** Destructive action with an inline second step instead of a blocking browser dialog. */
export function ConfirmButton({
  onConfirm,
  children,
  confirmLabel = "Confirm",
  prompt = "Are you sure?",
  variant = "danger",
  size = "sm",
  loading,
}: {
  onConfirm: () => void;
  children: React.ReactNode;
  confirmLabel?: string;
  prompt?: string;
  variant?: Variant;
  size?: Size;
  loading?: boolean;
}) {
  const [asking, setAsking] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (asking) ref.current?.focus();
  }, [asking]);
  if (!asking)
    return (
      <Button variant={variant === "danger" ? "ghost" : variant} size={size} onClick={() => setAsking(true)} loading={loading}>
        {children}
      </Button>
    );
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md bg-danger-soft px-2 py-0.5 text-[13px]">
      <span className="text-danger">{prompt}</span>
      <Button
        ref={ref}
        variant="danger"
        size="sm"
        onClick={() => {
          setAsking(false);
          onConfirm();
        }}
      >
        {confirmLabel}
      </Button>
      <Button variant="ghost" size="sm" onClick={() => setAsking(false)}>
        Cancel
      </Button>
    </span>
  );
}

export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: Array<{ value: T; label: React.ReactNode; count?: number }> }) {
  return (
    <div role="tablist" className="flex gap-5 border-b border-line">
      {tabs.map((t) => (
        <button
          key={t.value}
          role="tab"
          type="button"
          aria-selected={value === t.value}
          onClick={() => onChange(t.value)}
          className={cn(
            "-mb-px flex items-center gap-1.5 border-b-2 pb-2 pt-1 text-sm font-medium transition-colors",
            value === t.value ? "border-ledger text-ink" : "border-transparent text-muted hover:text-ink",
          )}
        >
          {t.label}
          {t.count !== undefined && <span className="num rounded-full bg-paper-deep px-1.5 text-xs text-muted">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function KeyValue({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={className}>
      <dt className="text-[12px] text-muted">{label}</dt>
      <dd className="mt-0.5 text-sm text-ink">{children}</dd>
    </div>
  );
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="rounded border border-line bg-paper px-1 py-px text-[11px] text-muted">{children}</kbd>;
}
