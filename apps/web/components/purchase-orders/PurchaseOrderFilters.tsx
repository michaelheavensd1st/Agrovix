import { PURCHASE_ORDER_STATUSES, type PurchaseOrderStatus } from '@/lib/purchase-orders';
import { purchaseOrderStatusLabel } from './PurchaseOrderStatusBadge';

export interface PurchaseOrderFiltersValue {
  farmId: string;
  businessPartnerId: string;
  statuses: PurchaseOrderStatus[];
  orderDateFrom: string;
  orderDateTo: string;
  expectedDeliveryFrom: string;
  expectedDeliveryTo: string;
  search: string;
  limit: 25 | 50 | 100 | 200;
}

export interface FilterOption {
  id: string;
  label: string;
}

export function PurchaseOrderFilters({
  value,
  farms,
  suppliers,
  onChange,
  onClear,
}: {
  value: PurchaseOrderFiltersValue;
  farms: FilterOption[];
  suppliers: FilterOption[];
  onChange: (next: PurchaseOrderFiltersValue) => void;
  onClear: () => void;
}) {
  function set<K extends keyof PurchaseOrderFiltersValue>(
    key: K,
    next: PurchaseOrderFiltersValue[K],
  ) {
    onChange({ ...value, [key]: next });
  }

  return (
    <section
      className="mb-5 space-y-4 rounded-xl border border-border bg-card p-4"
      aria-label="Purchase order filters"
      data-testid="po-filters"
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="text-sm">
          <span className="mb-1 block text-muted-foreground">Search supplier, PO or reference</span>
          <input
            data-testid="po-filter-search"
            type="search"
            value={value.search}
            onChange={(event) => set('search', event.target.value)}
            className="w-full rounded-md border border-border bg-background px-3 py-2"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-muted-foreground">Farm</span>
          <select
            data-testid="po-filter-farm"
            value={value.farmId}
            onChange={(event) => set('farmId', event.target.value)}
            className="w-full rounded-md border border-border bg-background px-3 py-2"
          >
            <option value="">All accessible farms</option>
            {farms.map((farm) => (
              <option key={farm.id} value={farm.id}>
                {farm.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-muted-foreground">Supplier</span>
          <select
            data-testid="po-filter-supplier"
            value={value.businessPartnerId}
            onChange={(event) => set('businessPartnerId', event.target.value)}
            className="w-full rounded-md border border-border bg-background px-3 py-2"
          >
            <option value="">All suppliers</option>
            {suppliers.map((supplier) => (
              <option key={supplier.id} value={supplier.id}>
                {supplier.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-muted-foreground">Page size</span>
          <select
            data-testid="po-filter-limit"
            value={value.limit}
            onChange={(event) =>
              set('limit', Number(event.target.value) as PurchaseOrderFiltersValue['limit'])
            }
            className="w-full rounded-md border border-border bg-background px-3 py-2"
          >
            {[25, 50, 100, 200].map((limit) => (
              <option key={limit} value={limit}>
                {limit}
              </option>
            ))}
          </select>
        </label>
      </div>

      <fieldset>
        <legend className="mb-2 text-sm text-muted-foreground">Status</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {PURCHASE_ORDER_STATUSES.map((status) => (
            <label key={status} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                data-testid={`po-filter-status-${status}`}
                checked={value.statuses.includes(status)}
                onChange={(event) =>
                  set(
                    'statuses',
                    event.target.checked
                      ? [...value.statuses, status]
                      : value.statuses.filter((candidate) => candidate !== status),
                  )
                }
              />
              {purchaseOrderStatusLabel(status)}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <DateFilter
          label="Order date from"
          testId="po-filter-order-from"
          value={value.orderDateFrom}
          onChange={(next) => set('orderDateFrom', next)}
        />
        <DateFilter
          label="Order date to"
          testId="po-filter-order-to"
          value={value.orderDateTo}
          onChange={(next) => set('orderDateTo', next)}
        />
        <DateFilter
          label="Delivery from"
          testId="po-filter-delivery-from"
          value={value.expectedDeliveryFrom}
          onChange={(next) => set('expectedDeliveryFrom', next)}
        />
        <DateFilter
          label="Delivery to"
          testId="po-filter-delivery-to"
          value={value.expectedDeliveryTo}
          onChange={(next) => set('expectedDeliveryTo', next)}
        />
      </div>

      <div className="flex justify-end">
        <button
          type="button"
          onClick={onClear}
          data-testid="po-filter-clear"
          className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-secondary"
        >
          Clear filters
        </button>
      </div>
    </section>
  );
}

function DateFilter({
  label,
  testId,
  value,
  onChange,
}: {
  label: string;
  testId: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="text-sm">
      <span className="mb-1 block text-muted-foreground">{label}</span>
      <input
        type="date"
        data-testid={testId}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-md border border-border bg-background px-3 py-2"
      />
    </label>
  );
}
