'use client';

import { useEffect, useRef, useState } from 'react';
import { ApiError } from '@/lib/api';
import { formatPurchaseOrderDecimal, formatPurchaseOrderMoney } from '@/lib/purchase-order-decimals';
import { getPurchaseReceipt, listReceiptStorageLocations, type PurchaseReceipt } from '@/lib/purchase-receipts';
import type { PurchaseOrder } from '@/lib/purchase-orders';
import { EmptyState, ErrorBanner } from '@/components/ape-ui';
import { SkeletonRows } from '@/components/ui-polish';
import { usePathname, useRouter } from 'next/navigation';

function timestamp(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );
}

export function PurchaseReceiptHistory({
  purchaseOrder,
  receipts,
  warehouseLabels,
  currentUserId,
  loading,
  error,
  nextCursor,
  canGoBack,
  navigationPending,
  onNext,
  onPrevious,
}: {
  purchaseOrder: PurchaseOrder;
  receipts: PurchaseReceipt[];
  warehouseLabels: ReadonlyMap<string, string>;
  currentUserId: string | null;
  loading: boolean;
  error: string | null;
  nextCursor: string | null;
  canGoBack: boolean;
  navigationPending: boolean;
  onNext: () => void;
  onPrevious: () => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<PurchaseReceipt | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [locationLabels, setLocationLabels] = useState(new Map<string, string>());
  const generationRef = useRef(0);

  useEffect(() => {
    setExpandedId(null);
    setDetail(null);
    setDetailError(null);
    setLocationLabels(new Map());
    generationRef.current += 1;
  }, [purchaseOrder.id]);

  useEffect(() => {
    if (!expandedId) return;
    const generation = ++generationRef.current;
    const capturedReceiptId = expandedId;
    const capturedPoId = purchaseOrder.id;
    const capturedOrganizationId = purchaseOrder.organization_id;
    const capturedFarmId = purchaseOrder.farm_id ?? '';
    const summary = receipts.find((receipt) => receipt.id === capturedReceiptId);
    const controller = new AbortController();
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    void Promise.all([
      getPurchaseReceipt(capturedReceiptId, controller.signal),
      summary ? listReceiptStorageLocations(summary.warehouse_id, controller.signal).catch(() => []) : Promise.resolve([]),
    ])
      .then(([received, locations]) => {
        if (
          generation !== generationRef.current ||
          capturedReceiptId !== expandedId ||
          capturedPoId !== purchaseOrder.id ||
          capturedOrganizationId !== purchaseOrder.organization_id ||
          capturedFarmId !== (purchaseOrder.farm_id ?? '') ||
          received.id !== capturedReceiptId ||
          received.purchase_order_id !== capturedPoId ||
          received.organization_id !== capturedOrganizationId ||
          (received.farm_id ?? '') !== capturedFarmId
        )
          return;
        setDetail(received);
        setLocationLabels(new Map(locations.map((location) => [location.id, `${location.name} (${location.code})`])));
      })
      .catch((caught) => {
        if (generation !== generationRef.current || (caught instanceof DOMException && caught.name === 'AbortError')) return;
        if (caught instanceof ApiError && caught.status === 401)
          router.push(`/login?returnTo=${encodeURIComponent(pathname)}`);
        else if (caught instanceof ApiError && caught.status === 404)
          setDetailError('This receipt is unavailable.');
        else if (caught instanceof ApiError && caught.status === 403)
          setDetailError('You do not have permission to view this receipt.');
        else setDetailError('Unable to load receipt details. Try again.');
      })
      .finally(() => {
        if (generation === generationRef.current) setDetailLoading(false);
      });
    return () => controller.abort();
  }, [expandedId, pathname, purchaseOrder.farm_id, purchaseOrder.id, purchaseOrder.organization_id, receipts, router]);

  return (
    <section className="rounded-xl border border-border bg-card p-5" data-testid="receipt-history">
      <h2 className="font-display text-xl">Receipt history</h2>
      <p className="mt-1 text-sm text-muted-foreground">Posted receipts are immutable.</p>
      {error && <div className="mt-4" role="alert"><ErrorBanner message={error} /></div>}
      {loading ? (
        <div className="mt-4" aria-busy="true"><SkeletonRows rows={4} /></div>
      ) : receipts.length === 0 && !error ? (
        <div className="mt-4"><EmptyState title="No receipts yet" description="Nothing has been received against this Purchase Order." /></div>
      ) : (
        <div className="mt-4 space-y-3">
          {receipts.map((receipt) => {
            const expanded = expandedId === receipt.id;
            return (
              <article key={receipt.id} className="rounded-lg border border-border" data-testid={`receipt-${receipt.id}`}>
                <button
                  type="button"
                  className="flex w-full flex-wrap items-center justify-between gap-3 p-4 text-left hover:bg-secondary/40"
                  aria-expanded={expanded}
                  onClick={() => setExpandedId(expanded ? null : receipt.id)}
                >
                  <span><span className="font-medium">{receipt.grn}</span><span className="ml-2 text-sm text-muted-foreground">{timestamp(receipt.received_at)}</span></span>
                  <span className="text-sm text-muted-foreground">{warehouseLabels.get(receipt.warehouse_id) ?? 'Warehouse unavailable'} · {receipt.lines.length} line{receipt.lines.length === 1 ? '' : 's'}</span>
                </button>
                {expanded && (
                  <div className="border-t border-border p-4" data-testid="receipt-detail">
                    {detailLoading && <SkeletonRows rows={3} />}
                    {detailError && <div role="alert"><ErrorBanner message={detailError} /></div>}
                    {detail && detail.id === receipt.id && (
                      <ReceiptDetail receipt={detail} purchaseOrder={purchaseOrder} warehouseLabels={warehouseLabels} locationLabels={locationLabels} currentUserId={currentUserId} />
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
      {(canGoBack || nextCursor) && (
        <nav className="mt-4 flex justify-end gap-2" aria-label="Receipt history pages">
          <button type="button" className="rounded-md border px-3 py-2 text-sm disabled:opacity-50" disabled={!canGoBack || navigationPending} onClick={onPrevious}>Previous</button>
          <button type="button" className="rounded-md border px-3 py-2 text-sm disabled:opacity-50" disabled={!nextCursor || navigationPending} onClick={onNext}>Next</button>
        </nav>
      )}
    </section>
  );
}

function ReceiptDetail({ receipt, purchaseOrder, warehouseLabels, locationLabels, currentUserId }: {
  receipt: PurchaseReceipt;
  purchaseOrder: PurchaseOrder;
  warehouseLabels: ReadonlyMap<string, string>;
  locationLabels: ReadonlyMap<string, string>;
  currentUserId: string | null;
}) {
  const poLines = new Map(purchaseOrder.lines.map((line) => [line.id, line]));
  return (
    <div className="space-y-4">
      <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
        <Info label="GRN" value={receipt.grn} />
        <Info label="Received" value={timestamp(receipt.received_at)} />
        <Info label="Warehouse" value={warehouseLabels.get(receipt.warehouse_id) ?? 'Warehouse unavailable'} />
        <Info label="Supplier delivery reference" value={receipt.supplier_delivery_reference ?? '—'} />
        <Info label="Received by" value={receipt.received_by_id === currentUserId ? 'You' : receipt.received_by_id} />
        <Info label="Posted" value={timestamp(receipt.created_at)} />
      </dl>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm"><thead><tr className="border-b"><th className="p-2">PO line</th><th className="p-2">Received</th><th className="p-2">Lot</th><th className="p-2">Location</th><th className="p-2">Expiry</th><th className="p-2">Price snapshot</th></tr></thead>
          <tbody>{receipt.lines.map((line) => { const poLine = poLines.get(line.purchase_order_line_id); return (
            <tr key={line.id} className="border-b last:border-0"><td className="p-2">{poLine ? `${poLine.line_number}. ${poLine.item_name}` : 'Purchase Order line unavailable'}</td><td className="p-2">{formatPurchaseOrderDecimal(line.quantity)} {line.ordered_unit}</td><td className="p-2">{line.lot_code}</td><td className="p-2">{line.storage_location_id ? (locationLabels.get(line.storage_location_id) ?? 'Location unavailable') : '—'}</td><td className="p-2">{line.expiry_date ?? '—'}</td><td className="p-2">{formatPurchaseOrderMoney(line.unit_price, line.currency_code)}</td></tr>
          ); })}</tbody>
        </table>
      </div>
      {receipt.notes && <div><p className="text-xs uppercase text-muted-foreground">Notes</p><p className="whitespace-pre-wrap text-sm">{receipt.notes}</p></div>}
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-muted-foreground">{label}</dt><dd className="break-words">{value}</dd></div>;
}
