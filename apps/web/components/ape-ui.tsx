'use client';

import Link from 'next/link';
import { ReactNode } from 'react';
import type { BatchState } from '@/lib/types';

/* ----------------------------------------------------------------- */
/* Breadcrumbs — never shows raw UUIDs as primary labels             */
/* ----------------------------------------------------------------- */

export interface Crumb {
  label: string;
  href?: string;
}

export function Breadcrumbs({ items }: { items: Crumb[] }) {
  return (
    <nav
      className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground"
      aria-label="Breadcrumb"
      data-testid="ape-breadcrumbs"
    >
      {items.map((c, i) => (
        <span key={i} className="flex items-center gap-1">
          {c.href ? (
            <Link
              href={c.href}
              className="rounded px-1.5 py-0.5 hover:bg-secondary hover:text-foreground"
            >
              {c.label}
            </Link>
          ) : (
            <span className="rounded px-1.5 py-0.5 font-medium text-foreground">{c.label}</span>
          )}
          {i < items.length - 1 && <span className="opacity-40">/</span>}
        </span>
      ))}
    </nav>
  );
}

/* ----------------------------------------------------------------- */
/* State badge — colour-coded batch lifecycle                        */
/* ----------------------------------------------------------------- */

const STATE_STYLES: Record<BatchState, string> = {
  planned: 'bg-muted text-foreground/80',
  stocked: 'bg-primary/10 text-primary',
  active: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  harvested: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
  closed: 'bg-secondary text-foreground/80',
  suspended: 'bg-yellow-500/10 text-yellow-700 dark:text-yellow-300',
  cancelled: 'bg-destructive/10 text-destructive',
  failed: 'bg-destructive/10 text-destructive',
};

export function StateBadge({ state }: { state: BatchState }) {
  return (
    <span
      data-testid={`batch-state-badge-${state}`}
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
        STATE_STYLES[state]
      }`}
    >
      {state}
    </span>
  );
}

/* ----------------------------------------------------------------- */
/* State primitives — empty / error / forbidden / loading            */
/* ----------------------------------------------------------------- */

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div
      className="rounded-2xl border border-dashed border-border bg-card/40 p-8 text-center text-sm text-muted-foreground"
      data-testid="ape-loading"
    >
      {label}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div
      className="rounded-2xl border border-dashed border-border bg-card/40 p-10 text-center"
      data-testid="ape-empty"
    >
      <p className="font-display text-lg">{title}</p>
      {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorBanner({ message }: { message: string }) {
  return (
    <div
      className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
      data-testid="ape-error"
    >
      {message}
    </div>
  );
}

export function ForbiddenBanner() {
  return (
    <div
      className="rounded-2xl border border-dashed border-border bg-card/40 p-10 text-center"
      data-testid="ape-forbidden"
    >
      <p className="font-display text-lg">You don&apos;t have access to this resource.</p>
      <p className="mt-1 text-sm text-muted-foreground">
        Ask an organization owner to grant you the right role and try again.
      </p>
    </div>
  );
}
