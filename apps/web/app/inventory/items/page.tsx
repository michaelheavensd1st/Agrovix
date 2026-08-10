'use client';

/**
 * Sprint 5.3 — Inventory Item list route.
 *
 * `/inventory/items` renders every inventory item that belongs to
 * the active organization only. It respects every Sprint 5.1/5.2
 * guarantee:
 *   - request-generation ref → stale org-A responses cannot stomp
 *     org-B state;
 *   - centralised 401/403 handling → 401 redirects to /login, 403
 *     shows a scoped forbidden banner (no toast on auth path);
 *   - organization-aware navigation → the create form, "Open"
 *     button, and workspace link all carry organization_id.
 *
 * Sprint 5.3 review round (Finding 3): organization selection is
 * reconciled with the URL via `useSearchParams` / `useRouter`. A
 * change from the org selector writes `organization_id` into the
 * URL through `router.replace()`, preserving every other query
 * parameter, so a fresh load reproduces the same selection and a
 * copied link points to the same organization.
 */

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { apiFetch, ApiError } from '@/lib/api';
import {
  DEFAULT_ITEM_FILTERS,
  DEFAULT_ITEM_SORT,
  filterItems,
  sortItems,
  type InventoryItem,
  type ItemListFilters,
  type ItemOrganization,
  type ItemSort,
} from '@/lib/inventory-items';
import { friendlyError, toast } from '@/components/ui-polish';
import { InventoryItemTable } from '@/components/inventory-items/inventory-item-table';
import { InventoryItemSearch } from '@/components/inventory-items/inventory-item-search';
import { InventoryItemFilters } from '@/components/inventory-items/inventory-item-filters';
import { InventoryItemEmptyState } from '@/components/inventory-items/inventory-item-empty-state';
import { InventoryItemForbiddenBanner } from '@/components/inventory-items/inventory-item-forbidden-banner';
import {
  InventoryItemForm,
  type ItemFormPayload,
} from '@/components/inventory-items/inventory-item-form';
import { SkeletonRows } from '@/components/ui-polish';

const PAGE_SIZE_OPTIONS = [10, 25, 50] as const;

// `useSearchParams` requires the containing tree to be inside a
// Suspense boundary during static generation. The inner component
// owns all client state so the Suspense fallback stays simple.
export default function InventoryItemListPage() {
  return (
    <Suspense
      fallback={
        <main className="mx-auto max-w-6xl px-6 py-10" data-testid="item-list-page-loading">
          <SkeletonRows rows={6} />
        </main>
      }
    >
      <InventoryItemListInner />
    </Suspense>
  );
}

function InventoryItemListInner() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [orgs, setOrgs] = useState<ItemOrganization[] | null>(null);
  const [orgId, setOrgId] = useState<string>('');
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState<{ scope: 'org'; message: string } | null>(null);
  const [filters, setFilters] = useState<ItemListFilters>(DEFAULT_ITEM_FILTERS);
  const [sort, setSort] = useState<ItemSort>(DEFAULT_ITEM_SORT);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<(typeof PAGE_SIZE_OPTIONS)[number]>(10);
  const [creating, setCreating] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const orgGenerationRef = useRef(0);
  const mountedRef = useRef(false);
  const currentOrgIdRef = useRef<string>('');
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      orgGenerationRef.current += 1;
    };
  }, []);
  useEffect(() => {
    currentOrgIdRef.current = orgId;
  }, [orgId]);

  // Read the URL organization_id reactively. `useSearchParams`
  // is the single source of truth for navigation context; the
  // effect below reconciles it into local state and normalizes
  // missing / invalid values back into the URL via
  // `router.replace()` so every entry point (direct navigation,
  // refresh, selector change, browser back/forward) converges
  // on the same invariant: the URL organization_id matches the
  // organization whose data is displayed.
  const requestedOrgId = searchParams.get('organization_id');

  // Bootstrap: load the list of accessible organizations. Selection
  // itself is derived reactively from the URL — see the sync effect.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await apiFetch<ItemOrganization[]>('/v1/organizations');
        if (cancelled) return;
        setOrgs(list);
        if (list.length === 0) {
          router.push('/onboarding');
          return;
        }
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

  // Unified URL ↔ state reconciliation. Runs whenever the URL org
  // parameter or the accessible orgs change (which is exactly when
  // "the effective organization" might need to be recomputed —
  // browser back/forward, direct navigation, selector changes, and
  // 0-org → n-org bootstrap all funnel through here).
  //
  // Rules:
  //   1. Requested org is valid   → use it.
  //   2. Requested org is missing → normalize URL to the fallback.
  //   3. Requested org is invalid → normalize URL to the fallback.
  //
  // Loop prevention: only replace when the URL's raw value differs
  // from the effective normalized value. When they match, we are
  // already at the fixed point and no replace fires.
  useEffect(() => {
    if (!orgs || orgs.length === 0) return;
    const isRequestedOrgValid =
      requestedOrgId !== null && orgs.some((o) => o.id === requestedOrgId);
    const effectiveOrgId = isRequestedOrgValid ? requestedOrgId : (orgs[0]?.id ?? null);
    if (!effectiveOrgId) return;
    if (effectiveOrgId !== orgId) setOrgId(effectiveOrgId);
    if (requestedOrgId !== effectiveOrgId) {
      const params = new URLSearchParams(searchParams.toString());
      params.set('organization_id', effectiveOrgId);
      router.replace(`${pathname}?${params.toString()}`);
    }
  }, [requestedOrgId, orgs, orgId, pathname, router, searchParams]);

  // Refetch items whenever the active org changes.
  const reloadItems = useCallback(async () => {
    if (!orgId) return;
    const capturedOrgId = orgId;
    const generation = ++orgGenerationRef.current;
    const isCurrent = () =>
      mountedRef.current && orgGenerationRef.current === generation && capturedOrgId === orgId;
    setLoading(true);
    try {
      const list = await apiFetch<InventoryItem[]>(
        `/v1/organizations/${capturedOrgId}/inventory-items`,
      );
      if (!isCurrent()) return;
      setItems(list);
      setForbidden((f) => (f?.scope === 'org' ? null : f));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        if (!isCurrent()) return;
        router.push('/login');
        return;
      }
      if (err instanceof ApiError && err.status === 403) {
        if (!isCurrent()) return;
        setItems([]);
        setForbidden({
          scope: 'org',
          message: "You don't have permission to view items in this organization.",
        });
        return;
      }
      if (!isCurrent()) return;
      toast(friendlyError(err), 'error');
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [orgId, router]);

  // Reset scoped state on org switch (protects against stale state).
  useEffect(() => {
    orgGenerationRef.current += 1;
    setItems([]);
    setForbidden(null);
    setFilters(DEFAULT_ITEM_FILTERS);
    setSort(DEFAULT_ITEM_SORT);
    setPage(1);
    setCreating(false);
    setCreateError(null);
  }, [orgId]);

  useEffect(() => {
    void reloadItems();
  }, [reloadItems]);

  const visible = useMemo(
    () => sortItems(filterItems(items, filters), sort),
    [items, filters, sort],
  );
  const totalPages = Math.max(1, Math.ceil(visible.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const paged = useMemo(
    () => visible.slice((currentPage - 1) * pageSize, currentPage * pageSize),
    [visible, currentPage, pageSize],
  );

  const activeOrg = useMemo(() => orgs?.find((o) => o.id === orgId) ?? null, [orgs, orgId]);

  function openItem(id: string) {
    const q = orgId ? `?organization_id=${encodeURIComponent(orgId)}` : '';
    router.push(`/inventory/items/${id}${q}`);
  }

  // Selector change: the URL is the single source of truth. We
  // write the URL via `router.replace()` (preserving unrelated
  // supported query parameters) and let the reconciliation effect
  // above propagate the change into `orgId`. This keeps direct
  // navigation, refresh, and selector changes on the same code path
  // and guarantees the URL always matches the displayed org.
  function handleOrgSelect(nextOrgId: string) {
    if (!nextOrgId || nextOrgId === orgId) return;
    const next = new URLSearchParams(searchParams.toString());
    next.set('organization_id', nextOrgId);
    router.replace(`${pathname}?${next.toString()}`);
  }

  async function submitCreate(payload: ItemFormPayload) {
    if (payload.mode !== 'create' || !orgId) return;
    // Capture the org that owned this mutation. A stale completion
    // must never navigate or reload inside a different organization.
    const mutationOrgId = orgId;
    setCreateBusy(true);
    setCreateError(null);
    try {
      const created = await apiFetch<InventoryItem>(
        `/v1/organizations/${mutationOrgId}/inventory-items`,
        {
          method: 'POST',
          body: JSON.stringify({
            code: payload.code,
            name: payload.name,
            description: payload.description,
            category: payload.category,
            canonical_unit: payload.canonical_unit,
            sku: payload.sku,
          }),
        },
      );
      // Only apply success side effects if the org that owned the
      // mutation is still the active one. We read from a ref so we
      // observe the *current* orgId rather than the stale closure
      // captured at submit time.
      if (mutationOrgId !== currentOrgIdRef.current) return;
      toast(`Item "${created.name}" created.`, 'success');
      setCreating(false);
      await reloadItems();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        router.push('/login');
        return;
      }
      if (mutationOrgId !== currentOrgIdRef.current) return;
      if (err instanceof ApiError && err.status === 409) {
        setCreateError(`An item with code "${payload.code}" already exists in this organization.`);
        return;
      }
      if (err instanceof ApiError && err.status === 403) {
        setCreateError("You don't have permission to create items in this organization.");
        return;
      }
      setCreateError(friendlyError(err));
    } finally {
      if (mutationOrgId === currentOrgIdRef.current) setCreateBusy(false);
    }
  }

  const filtersActive =
    filters.query !== '' ||
    filters.category !== 'all' ||
    filters.unit !== 'all' ||
    filters.status !== 'all';

  const workspaceHref = orgId
    ? `/inventory?organization_id=${encodeURIComponent(orgId)}`
    : '/inventory';

  return (
    <main className="mx-auto max-w-6xl px-6 py-10" data-testid="item-list-page">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-widest text-muted-foreground">
            Sprint 5.3 · Inventory
          </p>
          <h1 className="font-display text-3xl">Items</h1>
          {activeOrg && (
            <p className="mt-1 text-sm text-muted-foreground" data-testid="item-list-org-name">
              {activeOrg.name}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          {orgs && orgs.length > 1 && (
            <div className="flex items-center gap-2">
              <label className="text-muted-foreground" htmlFor="item-list-org-selector">
                Organization
              </label>
              <select
                id="item-list-org-selector"
                data-testid="item-list-org-selector"
                className="rounded-md border border-border bg-background px-2 py-1"
                value={orgId}
                onChange={(e) => handleOrgSelect(e.target.value)}
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
            href={workspaceHref}
            data-testid="item-list-workspace-link"
            className="rounded-md border border-border px-3 py-1.5 hover:bg-secondary"
          >
            Open workspace
          </Link>
          {!forbidden && (
            <button
              type="button"
              data-testid="item-list-new"
              onClick={() => {
                setCreating((v) => !v);
                setCreateError(null);
              }}
              className="rounded-md bg-primary px-3 py-1.5 font-medium text-primary-foreground"
            >
              {creating ? 'Cancel' : '+ New item'}
            </button>
          )}
        </div>
      </header>

      {creating && !forbidden && (
        <div className="mb-6">
          <InventoryItemForm
            mode="create"
            organizationName={activeOrg?.name ?? null}
            busy={createBusy}
            errorMessage={createError}
            onCancel={() => {
              setCreating(false);
              setCreateError(null);
            }}
            onSubmit={submitCreate}
          />
        </div>
      )}

      {forbidden ? (
        <InventoryItemForbiddenBanner scope="org" message={forbidden.message} />
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
            <div className="min-w-[220px] flex-1">
              <InventoryItemSearch
                onDebouncedChange={(v) => {
                  setFilters((f) => ({ ...f, query: v }));
                  setPage(1);
                }}
              />
            </div>
            <InventoryItemFilters
              filters={filters}
              onChange={(next) => {
                setFilters(next);
                setPage(1);
              }}
            />
          </div>

          {loading ? (
            <div data-testid="item-list-loading">
              <SkeletonRows rows={6} />
            </div>
          ) : items.length === 0 ? (
            <InventoryItemEmptyState variant="empty" onCreate={() => setCreating(true)} />
          ) : visible.length === 0 ? (
            <InventoryItemEmptyState
              variant="no-match"
              onClearFilters={() => {
                setFilters(DEFAULT_ITEM_FILTERS);
                setPage(1);
              }}
            />
          ) : (
            <>
              <InventoryItemTable
                items={paged}
                sort={sort}
                onSortChange={setSort}
                onOpen={openItem}
              />
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                <div>
                  Showing {paged.length} of {visible.length}
                  {filtersActive ? ` (filtered from ${items.length})` : ''}
                </div>
                <div className="flex items-center gap-2">
                  <label>
                    Rows per page{' '}
                    <select
                      data-testid="item-list-page-size"
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
                    data-testid="item-list-prev"
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    className="rounded-md border border-border px-2 py-0.5 disabled:opacity-40"
                  >
                    ← Prev
                  </button>
                  <span data-testid="item-list-page-indicator">
                    {currentPage} / {totalPages}
                  </span>
                  <button
                    type="button"
                    disabled={currentPage >= totalPages}
                    data-testid="item-list-next"
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
