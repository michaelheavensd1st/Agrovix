import {
  formatPurchaseOrderDecimal,
  formatPurchaseOrderMoney,
} from '@/lib/purchase-order-decimals';
import type { PurchaseOrderLine } from '@/lib/purchase-orders';

export function PurchaseOrderLines({
  lines,
  currencyCode,
}: {
  lines: PurchaseOrderLine[];
  currencyCode: string;
}) {
  if (lines.length === 0) {
    return <p className="text-sm text-muted-foreground">This Draft has no lines yet.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm" data-testid="po-detail-lines">
        <caption className="sr-only">Purchase order lines</caption>
        <thead className="text-left text-xs uppercase text-muted-foreground">
          <tr>
            <th scope="col" className="py-2 pr-4">
              Line
            </th>
            <th scope="col" className="py-2 pr-4">
              Item snapshot
            </th>
            <th scope="col" className="py-2 pr-4 text-right">
              Quantity
            </th>
            <th scope="col" className="py-2 pr-4">
              Unit
            </th>
            <th scope="col" className="py-2 pr-4 text-right">
              Unit price
            </th>
            <th scope="col" className="py-2 text-right">
              Extended
            </th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => (
            <tr key={line.id} className="border-t border-border" data-testid={`po-line-${line.id}`}>
              <td className="py-3 pr-4">{line.line_number}</td>
              <td className="py-3 pr-4">
                <div className="font-medium">{line.item_name}</div>
                <div className="text-xs text-muted-foreground">
                  {line.item_code}
                  {line.item_sku ? ` · ${line.item_sku}` : ''}
                </div>
                {line.description && <div className="mt-1 text-xs">{line.description}</div>}
              </td>
              <td className="py-3 pr-4 text-right tabular-nums">
                {formatPurchaseOrderDecimal(line.ordered_quantity)}
              </td>
              <td className="py-3 pr-4">{line.ordered_unit}</td>
              <td className="py-3 pr-4 text-right tabular-nums">
                {formatPurchaseOrderMoney(line.unit_price, currencyCode)}
              </td>
              <td className="py-3 text-right tabular-nums">
                {formatPurchaseOrderMoney(line.extended_amount, currencyCode)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
