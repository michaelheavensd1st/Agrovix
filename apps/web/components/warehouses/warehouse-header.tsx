import Link from 'next/link';
import type { Warehouse, WarehouseOrganization } from '@/lib/inventory-warehouses';
import { deriveScope, scopeLabel } from '@/lib/inventory-warehouses';
import { WarehouseStatusBadge } from './warehouse-status-badge';

/**
 * Sprint 5.2 — detail-page header. Shows the warehouse name +
 * code, org name (never mutable), scope + status, and a back
 * link that carries the current `?organization_id=…` so
 * navigation stays organization-aware.
 */
export function WarehouseHeader({
  warehouse,
  organization,
  onEdit,
  onStatusChange,
  editDisabled,
}: {
  warehouse: Warehouse;
  organization: WarehouseOrganization | null;
  onEdit: () => void;
  onStatusChange: (nextStatus: 'active' | 'closed') => void;
  editDisabled?: boolean;
}) {
  const scope = deriveScope(warehouse);
  const backHref = organization
    ? `/inventory/warehouses?organization_id=${encodeURIComponent(organization.id)}`
    : '/inventory/warehouses';
  const isClosed = warehouse.status === 'closed';
  return (
    <header
      className="mb-6 flex flex-wrap items-start justify-between gap-3"
      data-testid="warehouse-header"
    >
      <div>
        <Link
          href={backHref}
          data-testid="warehouse-header-back"
          className="text-xs uppercase tracking-widest text-muted-foreground hover:text-foreground"
        >
          ← All warehouses
        </Link>
        <h1 className="mt-1 font-display text-3xl" data-testid="warehouse-header-name">
          {warehouse.name}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          <span className="font-mono">{warehouse.code}</span>
          {organization && <span> · {organization.name}</span>}
          <span> · {scopeLabel(scope)}</span>
        </p>
        <div className="mt-2">
          <WarehouseStatusBadge status={warehouse.status} />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <button
          type="button"
          data-testid="warehouse-header-edit"
          onClick={onEdit}
          disabled={editDisabled}
          className="rounded-md border border-border px-3 py-1.5 hover:bg-secondary disabled:opacity-60"
        >
          Edit
        </button>
        {isClosed ? (
          <button
            type="button"
            data-testid="warehouse-header-reopen"
            onClick={() => onStatusChange('active')}
            className="rounded-md border border-border px-3 py-1.5 hover:bg-secondary"
          >
            Reopen warehouse
          </button>
        ) : (
          <button
            type="button"
            data-testid="warehouse-header-close"
            onClick={() => onStatusChange('closed')}
            className="rounded-md border border-destructive/50 px-3 py-1.5 text-destructive hover:bg-destructive/10"
          >
            Close warehouse
          </button>
        )}
      </div>
    </header>
  );
}
