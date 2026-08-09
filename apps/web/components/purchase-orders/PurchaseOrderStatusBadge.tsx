import type { PurchaseOrderStatus } from '@/lib/purchase-orders';

const LABELS: Record<PurchaseOrderStatus, string> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Submitted',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  PARTIALLY_RECEIVED: 'Partially received',
  RECEIVED: 'Received',
  CANCELLED: 'Cancelled',
  CANCELLED_WITH_RECEIPTS: 'Cancelled with receipts',
};

const STYLES: Record<PurchaseOrderStatus, string> = {
  DRAFT: 'bg-slate-100 text-slate-700',
  SUBMITTED: 'bg-blue-100 text-blue-800',
  APPROVED: 'bg-emerald-100 text-emerald-800',
  REJECTED: 'bg-rose-100 text-rose-800',
  PARTIALLY_RECEIVED: 'bg-amber-100 text-amber-800',
  RECEIVED: 'bg-teal-100 text-teal-800',
  CANCELLED: 'bg-slate-200 text-slate-700',
  CANCELLED_WITH_RECEIPTS: 'bg-slate-200 text-slate-700',
};

export function purchaseOrderStatusLabel(status: PurchaseOrderStatus): string {
  return LABELS[status];
}

export function PurchaseOrderStatusBadge({ status }: { status: PurchaseOrderStatus }) {
  return (
    <span
      className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${STYLES[status]}`}
      data-testid={`po-status-${status}`}
    >
      {LABELS[status]}
    </span>
  );
}
