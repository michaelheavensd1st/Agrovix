import Link from 'next/link';
import { formatPurchaseOrderMoney } from '@/lib/purchase-order-decimals';
import type { PurchaseOrder } from '@/lib/purchase-orders';
import { PurchaseOrderLines } from './PurchaseOrderLines';
import { PurchaseOrderStatusBadge } from './PurchaseOrderStatusBadge';

function actorLabel(actorId: string | null, currentUserId: string | null): string {
  if (!actorId) return '—';
  return actorId === currentUserId ? 'You' : actorId;
}

function timestamp(value: string | null): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );
}

export function PurchaseOrderDetail({
  purchaseOrder,
  currentUserId,
}: {
  purchaseOrder: PurchaseOrder;
  currentUserId: string | null;
}) {
  const po = purchaseOrder;
  const supplier = po.supplier_trading_name || po.supplier_legal_name;
  return (
    <div className="space-y-6" data-testid="po-detail">
      <header className="rounded-xl border border-border bg-card p-5">
        <Link
          href={`/purchase-orders?organization_id=${encodeURIComponent(po.organization_id)}`}
          className="text-sm text-muted-foreground hover:underline"
        >
          ← Back to purchase orders
        </Link>
        <div className="mt-4 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="break-words font-display text-3xl">{po.po_number}</h1>
              <PurchaseOrderStatusBadge status={po.status} />
            </div>
            <p className="mt-1 break-words text-muted-foreground">
              {supplier} · {po.supplier_code}
            </p>
          </div>
          <dl className="max-w-full text-left text-sm sm:text-right">
            <dt className="text-muted-foreground">Version</dt>
            <dd>v{po.version}</dd>
            <dt className="mt-2 text-muted-foreground">Farm scope</dt>
            <dd>{po.farm_id || 'Organization-wide'}</dd>
          </dl>
        </div>
      </header>

      <section className="grid gap-6 lg:grid-cols-2">
        <InfoSection title="Commercial summary">
          <dl className="grid gap-4 text-sm min-[375px]:grid-cols-2">
            <Info label="Currency" value={po.currency_code} />
            <Info
              label="Subtotal"
              value={formatPurchaseOrderMoney(po.subtotal, po.currency_code)}
            />
            <Info label="Order date" value={po.order_date} />
            <Info label="Expected delivery" value={po.expected_delivery_date || '—'} />
            <Info label="Supplier reference" value={po.supplier_reference || '—'} />
          </dl>
        </InfoSection>

        <InfoSection title="Delivery address">
          {po.delivery_address ? (
            <address className="text-sm not-italic" data-testid="po-delivery-address">
              {[
                po.delivery_address.line1,
                po.delivery_address.line2,
                po.delivery_address.city,
                po.delivery_address.region,
                po.delivery_address.postal_code,
                po.delivery_address.country_code,
              ]
                .filter(Boolean)
                .map((part) => (
                  <div key={part}>{part}</div>
                ))}
            </address>
          ) : (
            <p className="text-sm text-muted-foreground">No delivery address recorded.</p>
          )}
        </InfoSection>
      </section>

      <InfoSection title="Lines">
        <PurchaseOrderLines lines={po.lines} currencyCode={po.currency_code} />
      </InfoSection>

      <InfoSection title="Lifecycle metadata">
        <dl className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <Info label="Created by" value={actorLabel(po.created_by_id, currentUserId)} />
          <Info label="Created" value={timestamp(po.created_at)} />
          <Info label="Submitted by" value={actorLabel(po.submitted_by_id, currentUserId)} />
          <Info label="Submitted" value={timestamp(po.submitted_at)} />
          <Info label="Approved by" value={actorLabel(po.approved_by_id, currentUserId)} />
          <Info label="Approved" value={timestamp(po.approved_at)} />
          <Info label="Rejected by" value={actorLabel(po.rejected_by_id, currentUserId)} />
          <Info label="Rejected" value={timestamp(po.rejected_at)} />
          <Info label="Cancelled by" value={actorLabel(po.cancelled_by_id, currentUserId)} />
          <Info label="Cancelled" value={timestamp(po.cancelled_at)} />
        </dl>
        {po.notes && (
          <div className="mt-5">
            <p className="text-xs uppercase text-muted-foreground">Notes</p>
            <p className="mt-1 whitespace-pre-wrap text-sm">{po.notes}</p>
          </div>
        )}
      </InfoSection>
    </div>
  );
}

function InfoSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-card p-5">
      <h2 className="mb-4 font-display text-xl">{title}</h2>
      {children}
    </section>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="break-words">{value}</dd>
    </div>
  );
}
