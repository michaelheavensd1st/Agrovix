'use client';

/**
 * Sprint 5.2 — Warehouse list route.
 *
 * `/inventory/warehouses` renders every warehouse belonging to
 * the *active* organization only. Organization is resolved
 * exactly the way the Sprint 5.1 dashboard resolves it:
 * `?organization_id=…` is validated against the caller's real
 * orgs and silently falls back to the first one otherwise.
 *
 * The list respects every Sprint 5.1 guarantee:
 *   - request-generation ref → stale org-A responses cannot
 *     stomp org-B state;
 *   - centralised 401 / 403 handling → login redirect vs
 *     scoped ForbiddenBanner (no toast on the auth path);
 *   - organization-aware navigation → the create dialog, "Open"
 *     button, and Back link all carry `organization_id`.
 *
 * Row-level "Total inventory items" and "Last activity" columns
 * show `—` deliberately: the backend has no per-warehouse
 * aggregation, and the sprint spec explicitly forbids fan-out
 * over every warehouse in a list.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { apiFetch, ApiError } from '@/lib/api';
import {
  filterWarehouses,
  resolveOrganizationId,
  sortWarehouses,
  type Warehouse,
  type WarehouseListFilters,
  type WarehouseOrganization,
  type WarehouseSort,
} from '@/lib/inventory-warehouses';
import { friendlyError, toast } from '@/components/ui-polish';
import { WarehouseTable } from '@/components/warehouses/warehouse-table';
import { WarehouseSearch } from '@/components/warehouses/warehouse-search';
import { WarehouseFilters } from '@/components/warehouses/warehouse-filters';
import { WarehouseEmptyState } from '@/components/warehouses/warehouse-empty-state';
import { WarehouseLoadingSkeleton } from '@/components/warehouses/warehouse-loading-skeleton';
import { WarehouseForbiddenBanner } from '@/components/warehouses/warehouse-forbidden-banner';
import { WarehouseForm } from '@/components/warehouses/warehouse-form';

const DEFAULT_FILTERS: WarehouseListFilters = {
  query: '',
  status: 'all',
  scope: 'all',
};
const DEFAULT_SORT: WarehouseSort = { key: 'name', direction: 'asc' };
const PAGE_SIZE_OPTIONS = [10, 25, 50] as const;

function readInitialOrganizationId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return new URLSearchParams(window.location.search).get('organization_id');
  } catch {
    return null;
  }
}

export default function WarehouseListPage() {
  const router = useRouter();
  const [orgs, setOrgs] = useState<WarehouseOrganization[] | null>(null);
  const [orgId, setOrgId] = useState<string>('');
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState<{ scope: 'org'; message: string } | null>(null);
  const [filters, setFilters] = useState<WarehouseListFilters>(DEFAULT_FILTERS);
  const [sort, setSort] = useState<WarehouseSort>(DEFAULT_SORT);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<(typeof PAGE_SIZE_OPTIONS)[number]>(10);
  const [creating, setCreating] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const orgGenerationRef = useRef(0);
  const requestedOrgIdRef = useRef<string | null>(null);
  if (requestedOrgIdRef.current === null && typeof window !== 'undefined') {
    requestedOrgIdRef.current = readInitialOrganizationId();
  }

  // Bootstrap orgs -------------------------------------------------- //
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await apiFetch<WarehouseOrganization[]>('/v1/organizations');
        if (cancelled) return;
        setOrgs(list);
        if (list.length === 0) {
          router.push('/onboarding');
          return;
        }
        const validated = resolveOrganizationId(requestedOrgIdRef.current, list) ?? list[0].id;
        setOrgId(validated);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          router.push('/login');
          return;
        }
        if (err instanceof ApiError && err.status === 403) {
          setForbidden({
            scope: 'org',
            message: "You don't have permission to view organizations.",
          });
          setLoading(false);
          return;
        }
        toast(friendlyError(err), 'error');
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  // Reload warehouses ---------------------------------------------- //
  const reloadWarehouses = useCallback(async () => {
    if (!orgId) return;
    const capturedOrgId = orgId;
    const generation = ++orgGenerationRef.current;
    const isCurrent = () => orgGenerationRef.current === generation && capturedOrgId === orgId;
    setLoading(true);
    try {
      const list = await apiFetch<Warehouse[]>(`/v1/organizations/${capturedOrgId}/warehouses`);
      if (!isCurrent()) return;
      setWarehouses(list);
      setForbidden((f) => (f?.scope === 'org' ? null : f));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        router.push('/login');
        return;
      }
      if (err instanceof ApiError && err.status === 403) {
        if (!isCurrent()) return;
        setWarehouses([]);
        setForbidden({
          scope: 'org',
          message: "You don't have permission to view warehouses in this organization.",
        });
        return;
      }
      if (!isCurrent()) return;
      toast(friendlyError(err), 'error');
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [orgId, router]);

  // Org change: clear stale state before refetching.
  useEffect(() => {
    orgGenerationRef.current += 1;
    setWarehouses([]);
    setForbidden(null);
    setFilters(DEFAULT_FILTERS);
    setSort(DEFAULT_SORT);
    setPage(1);
    setCreating(false);
    setCreateError(null);
  }, [orgId]);

  useEffect(() => {
    void reloadWarehouses();
  }, [reloadWarehouses]);

  // Filtered / sorted / paged view --------------------------------- //
  const visible = useMemo(
    () => sortWarehouses(filterWarehouses(warehouses, filters), sort),
    [warehouses, filters, sort],
  );
  const totalPages = Math.max(1, Math.ceil(visible.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const paged = useMemo(
    () => visible.slice((currentPage - 1) * pageSize, currentPage * pageSize),
    [visible, currentPage, pageSize],
  );

  const activeOrg = useMemo(() => orgs?.find((o) => o.id === orgId) ?? null, [orgs, orgId]);

  // Handlers ------------------------------------------------------- //
  function openWarehouse(id: string) {
    const q = orgId ? `?organization_id=${encodeURIComponent(orgId)}` : '';
    router.push(`/inventory/warehouses/${id}${q}`);
  }

  async function submitCreate(payload: {
    mode: 'create';
    name: string;
    code: string;
    description: string;
    address: string;
  }) {
    if (!orgId) return;
    setCreateBusy(true);
    setCreateError(null);
    try {
      await apiFetch<Warehouse>(`/v1/organizations/${orgId}/warehouses`, {
        method: 'POST',
        body: JSON.stringify({
          name: payload.name,
          code: payload.code,
          description: payload.description || null,
          address: payload.address || null,
        }),
      });
      toast(`Warehouse "${payload.name}" created.`, 'success');
      setCreating(false);
      await reloadWarehouses();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        router.push('/login');
        return;
      }
      if (err instanceof ApiError && err.status === 409) {
        setCreateError(
          `A warehouse with code "${payload.code}" already exists in this organization.`,
        );
        return;
      }
      if (err instanceof ApiError && err.status === 403) {
        setCreateError("You don't have permission to create warehouses in this organization.");
        return;
      }
      setCreateError(friendlyError(err));
    } finally {
      setCreateBusy(false);
    }
  }

  const filtersActive = filters.query !== '' || filters.status !== 'all' || filters.scope !== 'all';

  return (
    <main className="mx-auto max-w-6xl px-6 py-10" data-testid="warehouse-list-page">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-widest text-muted-foreground">
            Sprint 5.2 · Inventory
          </p>
          <h1 className="font-display text-3xl">Warehouses</h1>
          {activeOrg && (
            <p className="mt-1 text-sm text-muted-foreground" data-testid="warehouse-list-org-name">
              {activeOrg.name}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          {orgs && orgs.length > 1 && (
            <div className="flex items-center gap-2">
              <label className="text-muted-foreground" htmlFor="warehouse-list-org-selector">
                Organization
              </label>
              <select
                id="warehouse-list-org-selector"
                data-testid="warehouse-list-org-selector"
                className="rounded-md border border-border bg-background px-2 py-1"
                value={orgId}
                onChange={(e) => setOrgId(e.target.value)}
              >
                {orgs.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <Link
            href={orgId ? `/inventory?organization_id=${encodeURIComponent(orgId)}` : '/inventory'}
            data-testid="warehouse-list-workspace-link"
            className="rounded-md border border-border px-3 py-1.5 hover:bg-secondary"
          >
            Open workspace
          </Link>
          {!forbidden && (
            <button
              type="button"
              data-testid="warehouse-list-new"
              onClick={() => {
                setCreating((v) => !v);
                setCreateError(null);
              }}
              className="rounded-md bg-primary px-3 py-1.5 font-medium text-primary-foreground"
            >
              {creating ? 'Cancel' : '+ New warehouse'}
            </button>
          )}
        </div>
      </header>

      {creating && !forbidden && (
        <div className="mb-6">
          <WarehouseForm
            mode="create"
            organizationName={activeOrg?.name ?? null}
            busy={createBusy}
            errorMessage={createError}
            onCancel={() => {
              setCreating(false);
              setCreateError(null);
            }}
            onSubmit={(payload) => {
              if (payload.mode === 'create') void submitCreate(payload);
            }}
          />
        </div>
      )}

      {forbidden ? (
        <WarehouseForbiddenBanner scope="org" message={forbidden.message} />
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
            <div className="min-w-[220px] flex-1">
              <WarehouseSearch
                onDebouncedChange={(v) => {
                  setFilters((f) => ({ ...f, query: v }));
                  setPage(1);
                }}
              />
            </div>
            <WarehouseFilters
              filters={filters}
              onChange={(next) => {
                setFilters(next);
                setPage(1);
              }}
            />
          </div>

          {loading ? (
            <WarehouseLoadingSkeleton rows={6} testId="warehouse-list-loading" />
          ) : warehouses.length === 0 ? (
            <WarehouseEmptyState variant="empty" onCreate={() => setCreating(true)} />
          ) : visible.length === 0 ? (
            <WarehouseEmptyState
              variant="no-match"
              onClearFilters={() => {
                setFilters(DEFAULT_FILTERS);
                setPage(1);
              }}
            />
          ) : (
            <>
              <WarehouseTable
                warehouses={paged}
                sort={sort}
                onSortChange={setSort}
                onOpen={openWarehouse}
              />
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                <div>
                  Showing {paged.length} of {visible.length}
                  {filtersActive ? ` (filtered from ${warehouses.length})` : ''}
                </div>
                <div className="flex items-center gap-2">
                  <label>
                    Rows per page{' '}
                    <select
                      data-testid="warehouse-list-page-size"
                      value={pageSize}
                      onChange={(e) => {
                        setPageSize(Number(e.target.value) as (typeof PAGE_SIZE_OPTIONS)[number]);
                        setPage(1);
                      }}
                      className="rounded-md border border-border bg-background px-1 py-0.5"
                    >
                      {PAGE_SIZE_OPTIONS.map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    disabled={currentPage <= 1}
                    data-testid="warehouse-list-prev"
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    className="rounded-md border border-border px-2 py-0.5 disabled:opacity-40"
                  >
                    ← Prev
                  </button>
                  <span data-testid="warehouse-list-page-indicator">
                    {currentPage} / {totalPages}
                  </span>
                  <button
                    type="button"
                    disabled={currentPage >= totalPages}
                    data-testid="warehouse-list-next"
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    className="rounded-md border border-border px-2 py-0.5 disabled:opacity-40"
                  >
                    Next →
                  </button>
                </div>
              </div>
            </>
          )}
        </>
      )}
    </main>
  );
}
