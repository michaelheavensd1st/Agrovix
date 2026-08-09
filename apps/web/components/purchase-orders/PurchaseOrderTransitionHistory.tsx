import type { PurchaseOrderTransition } from '@/lib/purchase-orders';
import { PurchaseOrderStatusBadge } from './PurchaseOrderStatusBadge';

export function PurchaseOrderTransitionHistory({
  transitions,
  currentUserId,
  loading,
  error,
  nextCursor,
  canGoBack,
  onNext,
  onPrevious,
}: {
  transitions: PurchaseOrderTransition[];
  currentUserId: string | null;
  loading: boolean;
  error: string | null;
  nextCursor: string | null;
  canGoBack: boolean;
  onNext: () => void;
  onPrevious: () => void;
}) {
  return (
    <section
      className="rounded-xl border border-border bg-card p-5"
      aria-busy={loading}
      data-testid="po-transition-history"
    >
      <h2 className="font-display text-xl">Transition history</h2>
      {loading ? (
        <p className="mt-4 text-sm text-muted-foreground" data-testid="po-transitions-loading">
          Loading transition history…
        </p>
      ) : error ? (
        <div
          className="mt-4 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
          data-testid="po-transitions-error"
          role="alert"
        >
          {error}
        </div>
      ) : transitions.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground" data-testid="po-transitions-empty">
          No transitions recorded.
        </p>
      ) : (
        <ol className="mt-4 space-y-3">
          {transitions.map((transition) => (
            <li
              key={transition.id}
              className="rounded-lg border border-border p-3"
              data-testid={`po-transition-${transition.id}`}
            >
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium">{transition.operation || 'Transition'}</span>
                {transition.from_status ? (
                  <PurchaseOrderStatusBadge status={transition.from_status} />
                ) : (
                  <span className="text-muted-foreground">Created</span>
                )}
                <span aria-hidden="true">→</span>
                <PurchaseOrderStatusBadge status={transition.to_status} />
              </div>
              <p className="mt-2 break-all text-xs text-muted-foreground">
                Actor: {transition.actor_id === currentUserId ? 'You' : transition.actor_id} ·{' '}
                {new Intl.DateTimeFormat(undefined, {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                }).format(new Date(transition.occurred_at))}
              </p>
              {transition.reason && <p className="mt-2 text-sm">{transition.reason}</p>}
            </li>
          ))}
        </ol>
      )}
      {!loading && !error && (canGoBack || nextCursor) && (
        <nav className="mt-4 flex justify-end gap-2" aria-label="Transition history pages">
          <button
            type="button"
            onClick={onPrevious}
            disabled={!canGoBack}
            data-testid="po-transitions-previous"
            className="rounded-md border border-border px-3 py-1.5 text-sm disabled:opacity-50"
          >
            Previous
          </button>
          <button
            type="button"
            onClick={onNext}
            disabled={!nextCursor}
            data-testid="po-transitions-next"
            className="rounded-md border border-border px-3 py-1.5 text-sm disabled:opacity-50"
          >
            Next
          </button>
        </nav>
      )}
    </section>
  );
}
