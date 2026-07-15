'use client';

/**
 * Sprint 4 lightweight UX polish primitives — toast bus, skeleton
 * blocks, empty-state CTA, confirmation dialog, and a friendly-error
 * mapper that translates common API error codes (idempotency, 409
 * conflicts, closed lots, etc.) into user-facing language.
 *
 * We deliberately stick to plain Tailwind + no external deps so the
 * inventory workspace matches the visual language of the existing
 * farm / batch pages. A design-system consolidation pass to Shadcn
 * UI is tracked as a separate backlog item.
 */

import { ReactNode, useEffect, useSyncExternalStore } from 'react';
import { ApiError } from '@/lib/api';

// -------------------------------------------------------------------- //
// Toast bus (module-level subject; no context provider required)      //
// -------------------------------------------------------------------- //

export type ToastKind = 'success' | 'error' | 'info';
export interface Toast {
  id: string;
  kind: ToastKind;
  message: string;
}

type Listener = (toasts: Toast[]) => void;

let TOASTS: Toast[] = [];
const listeners = new Set<Listener>();

function emit() {
  for (const l of listeners) l(TOASTS);
}

export function toast(message: string, kind: ToastKind = 'info', ttlMs = 4200) {
  const id = `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  TOASTS = [...TOASTS, { id, kind, message }];
  emit();
  window.setTimeout(() => {
    TOASTS = TOASTS.filter((t) => t.id !== id);
    emit();
  }, ttlMs);
}

function subscribe(listener: Listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): Toast[] {
  return TOASTS;
}

const EMPTY_TOASTS: Toast[] = [];
function getServerSnapshot(): Toast[] {
  return EMPTY_TOASTS;
}

function useToasts(): Toast[] {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export function Toaster() {
  const toasts = useToasts();
  return (
    <div
      className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[min(360px,calc(100vw-2rem))] flex-col gap-2"
      data-testid="ui-toaster"
      role="region"
      aria-live="polite"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          data-testid={`ui-toast-${t.kind}`}
          className={`pointer-events-auto rounded-md border px-3 py-2 text-sm shadow-md backdrop-blur transition ${
            t.kind === 'success'
              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200'
              : t.kind === 'error'
                ? 'border-destructive/40 bg-destructive/10 text-destructive'
                : 'border-border bg-card/95 text-foreground'
          }`}
        >
          {t.message}
        </div>
      ))}
    </div>
  );
}

// -------------------------------------------------------------------- //
// Skeleton                                                            //
// -------------------------------------------------------------------- //

export function Skeleton({
  className = '',
  testId,
}: {
  className?: string;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId ?? 'ui-skeleton'}
      className={`animate-pulse rounded-md bg-muted/60 ${className}`}
    />
  );
}

export function SkeletonRows({
  rows = 4,
  testId = 'ui-skeleton-rows',
}: {
  rows?: number;
  testId?: string;
}) {
  return (
    <div className="space-y-2" data-testid={testId}>
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </div>
  );
}

// -------------------------------------------------------------------- //
// Empty state with CTA                                                //
// -------------------------------------------------------------------- //

export function EmptyStateCard({
  title,
  description,
  action,
  testId = 'ui-empty',
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      className="rounded-2xl border border-dashed border-border bg-card/40 p-8 text-center"
    >
      <p className="font-display text-lg">{title}</p>
      {description && (
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      )}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

// -------------------------------------------------------------------- //
// Confirmation dialog                                                 //
// -------------------------------------------------------------------- //

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  onConfirm,
  onCancel,
  busy = false,
  testId = 'ui-confirm',
}: {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
  testId?: string;
}) {
  // ESC dismiss.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onCancel();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, busy, onCancel]);

  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
      data-testid={testId}
    >
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-5 shadow-lg">
        <h2 className="font-display text-lg">{title}</h2>
        {description && (
          <p className="mt-2 text-sm text-muted-foreground">{description}</p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            data-testid={`${testId}-cancel`}
            className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-secondary disabled:opacity-60"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            data-testid={`${testId}-confirm`}
            className={`rounded-md px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-60 ${
              destructive ? 'bg-destructive' : 'bg-primary'
            }`}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// -------------------------------------------------------------------- //
// Friendly error mapper                                               //
// -------------------------------------------------------------------- //

/** Map common backend error codes to human-friendly language. */
const ERROR_CODE_MAP: Record<string, string> = {
  idempotency_key_payload_conflict:
    'Duplicate submission with a different payload was detected. Refresh and try again.',
  idempotency_key_required:
    'Missing idempotency key on this operation. Please retry — the app will generate a fresh key.',
  insufficient_stock:
    'The lot does not have enough on-hand quantity for this operation.',
  lot_closed_no_writes:
    'This lot is closed and can no longer be modified. Create a new lot instead.',
  warehouse_closed_no_writes:
    'This warehouse is closed and no longer accepts inventory movements.',
  reverse_transaction_already_reversed:
    'This transaction has already been reversed and cannot be reversed again.',
  transfer_same_warehouse_blocked:
    'Source and destination warehouses must differ. Pick a different destination.',
  unit_incompatible:
    'The unit you selected is incompatible with the item’s canonical unit.',
  quantity_must_be_positive: 'Quantity must be greater than zero.',
};

export function friendlyError(err: unknown): string {
  if (err instanceof ApiError) {
    const detail = err.payload?.detail as unknown;
    if (typeof detail === 'string') {
      return ERROR_CODE_MAP[detail] ?? detail;
    }
    if (detail && typeof detail === 'object') {
      const obj = detail as { code?: string; message?: string };
      if (obj.code && ERROR_CODE_MAP[obj.code]) return ERROR_CODE_MAP[obj.code];
      if (obj.message) return obj.message;
      if (obj.code) return obj.code;
    }
    if (err.status === 409) {
      return 'Conflict — someone else changed this resource, or your request duplicates a previous one. Refresh and try again.';
    }
    if (err.status === 403) {
      return 'You do not have permission to perform this action.';
    }
    if (err.status === 404) {
      return 'That resource no longer exists.';
    }
    return err.message || `Request failed (${err.status}).`;
  }
  return err instanceof Error ? err.message : String(err);
}
