import type { PurchaseOrder } from '@/lib/purchase-orders';

export function PurchaseOrderConflictPanel({
  originalVersion,
  latest,
  onReviewLatest,
  onDiscard,
}: {
  originalVersion: number;
  latest: PurchaseOrder;
  onReviewLatest: () => void;
  onDiscard: () => void;
}) {
  const editable = latest.status === 'DRAFT';
  return (
    <section
      role="alert"
      aria-labelledby="po-conflict-title"
      data-testid="po-conflict-panel"
      className="rounded-xl border border-amber-500 bg-amber-50 p-5 text-amber-950"
    >
      <h2 id="po-conflict-title" className="font-display text-xl">
        This Draft changed elsewhere
      </h2>
      <p className="mt-2 text-sm">
        You started from version {originalVersion}; the server now has version {latest.version} with
        status {latest.status}. Your local edits have not been overwritten.
      </p>
      {!editable && (
        <p className="mt-2 text-sm font-medium">
          The Purchase Order is no longer a Draft and cannot be edited.
        </p>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onReviewLatest}
          className="rounded-md border border-amber-700 px-3 py-1.5 text-sm"
        >
          Review latest
        </button>
        <button
          type="button"
          onClick={onDiscard}
          className="rounded-md bg-amber-900 px-3 py-1.5 text-sm text-white"
        >
          Discard local edits and reload
        </button>
      </div>
    </section>
  );
}
