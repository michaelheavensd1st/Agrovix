import type { Warehouse, WarehouseOrganization } from '@/lib/inventory-warehouses';
import { deriveScope, scopeLabel, statusLabel } from '@/lib/inventory-warehouses';

/**
 * Sprint 5.2 — read-only summary card for the warehouse detail
 * view. Deliberately omits any invented fields (no fake site
 * name, no fake `type`); where the backend cannot answer a
 * question, we surface an explicit "not set" state rather than a
 * placeholder that pretends to have a value.
 *
 * `site_id` is shown as technical metadata only (per sprint
 * scope decision) so operators can copy it into a support
 * ticket without ever mistaking a UUID for a resolved site name.
 */
export function WarehouseSummary({
  warehouse,
  organization,
}: {
  warehouse: Warehouse;
  organization: WarehouseOrganization | null;
}) {
  const scope = deriveScope(warehouse);
  const rows: [string, React.ReactNode, string][] = [
    ['Name', warehouse.name, 'name'],
    [
      'Code',
      <span key="code" className="font-mono">
        {warehouse.code}
      </span>,
      'code',
    ],
    ['Organization', organization?.name ?? '—', 'organization'],
    ['Scope', scopeLabel(scope), 'scope'],
    ['Status', statusLabel(warehouse.status), 'status'],
    ['Description', warehouse.description ?? 'Not set', 'description'],
    ['Address', warehouse.address ?? 'Not set', 'address'],
  ];
  return (
    <section className="rounded-2xl border border-border p-4" data-testid="warehouse-summary">
      <h2 className="mb-3 font-display text-lg">Summary</h2>
      <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
        {rows.map(([label, value, key]) => (
          <div key={key} className="flex flex-col">
            <dt className="text-xs uppercase tracking-widest text-muted-foreground">{label}</dt>
            <dd className="text-sm" data-testid={`warehouse-summary-${key}`}>
              {value}
            </dd>
          </div>
        ))}
        {warehouse.site_id && (
          <div className="col-span-full mt-2 flex flex-col rounded-md bg-secondary/40 p-2">
            <dt className="text-[10px] uppercase tracking-widest text-muted-foreground">
              Site reference (technical metadata)
            </dt>
            <dd
              className="font-mono text-[11px] text-muted-foreground"
              data-testid="warehouse-summary-site-id"
            >
              {warehouse.site_id}
            </dd>
          </div>
        )}
      </dl>
    </section>
  );
}
