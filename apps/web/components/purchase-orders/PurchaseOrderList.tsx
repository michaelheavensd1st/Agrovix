import Link from 'next/link';
import { formatPurchaseOrderMoney } from '@/lib/purchase-order-decimals';
import type { PurchaseOrder } from '@/lib/purchase-orders';
import { PurchaseOrderStatusBadge } from './PurchaseOrderStatusBadge';

function displayDate(value: string | null): string {
  return value || '—';
}

function displayTimestamp(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );
}

export function PurchaseOrderList({
  rows,
  farmNames,
}: {
  rows: PurchaseOrder[];
  farmNames: ReadonlyMap<string, string>;
}) {
  return (
    <div data-testid="po-list-results">
      <div className="hidden overflow-x-auto rounded-xl border border-border md:block">
        <table className="min-w-full text-sm" data-testid="po-table">
          <caption className="sr-only">Purchase orders</caption>
          <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th scope="col" className="px-3 py-3">
                PO number
              </th>
              <th scope="col" className="px-3 py-3">
                Supplier
              </th>
              <th scope="col" className="px-3 py-3">
                Farm
              </th>
              <th scope="col" className="px-3 py-3">
                Status
              </th>
              <th scope="col" className="px-3 py-3">
                Order date
              </th>
              <th scope="col" className="px-3 py-3">
                Expected delivery
              </th>
              <th scope="col" className="px-3 py-3 text-right">
                Subtotal
              </th>
              <th scope="col" className="px-3 py-3">
                Version
              </th>
              <th scope="col" className="px-3 py-3">
                Updated
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((po) => (
              <tr key={po.id} className="border-t border-border" data-testid={`po-row-${po.id}`}>
                <td className="px-3 py-3 font-medium">
                  <Link href={`/purchase-orders/${po.id}`} className="hover:underline">
                    {po.po_number}
                  </Link>
                </td>
                <td className="px-3 py-3">
                  <div>{po.supplier_trading_name || po.supplier_legal_name}</div>
                  <div className="text-xs text-muted-foreground">{po.supplier_code}</div>
                </td>
                <td className="px-3 py-3">
                  {po.farm_id ? farmNames.get(po.farm_id) || 'Scoped farm' : 'Organization-wide'}
                </td>
                <td className="px-3 py-3">
                  <PurchaseOrderStatusBadge status={po.status} />
                </td>
                <td className="px-3 py-3">{displayDate(po.order_date)}</td>
                <td className="px-3 py-3">{displayDate(po.expected_delivery_date)}</td>
                <td className="px-3 py-3 text-right tabular-nums">
                  {formatPurchaseOrderMoney(po.subtotal, po.currency_code)}
                </td>
                <td className="px-3 py-3">v{po.version}</td>
                <td className="px-3 py-3 text-xs text-muted-foreground">
                  {displayTimestamp(po.updated_at)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="space-y-3 md:hidden" data-testid="po-card-list">
        {rows.map((po) => (
          <article
            key={po.id}
            className="rounded-xl border border-border bg-card p-4"
            data-testid={`po-card-${po.id}`}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <Link href={`/purchase-orders/${po.id}`} className="font-medium hover:underline">
                  {po.po_number}
                </Link>
                <p className="mt-1 text-sm">{po.supplier_trading_name || po.supplier_legal_name}</p>
              </div>
              <PurchaseOrderStatusBadge status={po.status} />
            </div>
            <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-muted-foreground">Farm</dt>
                <dd>
                  {po.farm_id ? farmNames.get(po.farm_id) || 'Scoped farm' : 'Organization-wide'}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Total</dt>
                <dd className="tabular-nums">
                  {formatPurchaseOrderMoney(po.subtotal, po.currency_code)}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Order date</dt>
                <dd>{po.order_date}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Delivery</dt>
                <dd>{displayDate(po.expected_delivery_date)}</dd>
              </div>
            </dl>
            <p className="mt-3 text-xs text-muted-foreground">
              Version {po.version} · Updated {displayTimestamp(po.updated_at)}
            </p>
          </article>
        ))}
      </div>
    </div>
  );
}
