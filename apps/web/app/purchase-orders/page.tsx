'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { ApiError, apiFetch } from '@/lib/api';
import { listBusinessPartners } from '@/lib/business-partners';
import { SkeletonRows, toast } from '@/components/ui-polish';
import { EmptyState, ErrorBanner, ForbiddenBanner } from '@/components/ape-ui';
import {
  PurchaseOrderFilters,
  type PurchaseOrderFiltersValue,
} from '@/components/purchase-orders/PurchaseOrderFilters';
import { PurchaseOrderList } from '@/components/purchase-orders/PurchaseOrderList';
import {
  PURCHASE_ORDER_STATUSES,
  listPurchaseOrders,
  type PurchaseOrder,
  type PurchaseOrderStatus,
} from '@/lib/purchase-orders';
import type { CurrentUser, Farm, Organization } from '@/lib/types';
import { hasScopedPermission } from '@/lib/permissions';

const DEFAULT_FILTERS: PurchaseOrderFiltersValue = {
  farmId: '',
  businessPartnerId: '',
  statuses: [],
  orderDateFrom: '',
  orderDateTo: '',
  expectedDeliveryFrom: '',
  expectedDeliveryTo: '',
  search: '',
  limit: 50,
};

const LIMITS = new Set([25, 50, 100, 200]);

function filtersFromSearchParams(params: URLSearchParams): PurchaseOrderFiltersValue {
  const rawLimit = Number(params.get('limit') || 50);
  return {
    farmId: params.get('farm_id') || '',
    businessPartnerId: params.get('business_partner_id') || '',
    statuses: params
      .getAll('status')
      .filter((status): status is PurchaseOrderStatus =>
        PURCHASE_ORDER_STATUSES.includes(status as PurchaseOrderStatus),
      ),
    orderDateFrom: params.get('order_date_from') || '',
    orderDateTo: params.get('order_date_to') || '',
    expectedDeliveryFrom: params.get('expected_delivery_from') || '',
    expectedDeliveryTo: params.get('expected_delivery_to') || '',
    search: params.get('search') || '',
    limit: (LIMITS.has(rawLimit) ? rawLimit : 50) as PurchaseOrderFiltersValue['limit'],
  };
}

function hasAnyReadPermission(user: CurrentUser | null, organizationId: string): boolean {
  if (!user) return false;
  if (
    user.is_superuser ||
    user.permissions.includes('*') ||
    user.permissions.includes('purchase_order.read')
  )
    return true;
  return (user.permission_scopes ?? []).some(
    (scope) =>
      scope.organization_id === organizationId &&
      (scope.permissions.includes('*') || scope.permissions.includes('purchase_order.read')),
  );
}

function hasApplicablePermission(
  user: CurrentUser | null,
  permission: string,
  organizationId: string,
  farmId?: string,
): boolean {
  if (!user) return false;
  if (hasScopedPermission(user, permission, { organizationId, ...(farmId ? { farmId } : {}) }))
    return true;
  if (farmId) return false;
  return (user.permission_scopes ?? []).some(
    (scope) =>
      scope.organization_id === organizationId &&
      (scope.permissions.includes('*') || scope.permissions.includes(permission)),
  );
}

function listViewIdentity(
  organizationId: string,
  filters: PurchaseOrderFiltersValue,
  cursor: string | undefined,
): string {
  return JSON.stringify([
    organizationId,
    filters.farmId,
    filters.businessPartnerId,
    filters.statuses,
    filters.orderDateFrom,
    filters.orderDateTo,
    filters.expectedDeliveryFrom,
    filters.expectedDeliveryTo,
    filters.search.trim(),
    filters.limit,
    cursor ?? '',
  ]);
}

function listScopeIdentity(organizationId: string, filters: PurchaseOrderFiltersValue): string {
  return JSON.stringify([
    organizationId,
    filters.farmId,
    filters.businessPartnerId,
    filters.statuses,
    filters.orderDateFrom,
    filters.orderDateTo,
    filters.expectedDeliveryFrom,
    filters.expectedDeliveryTo,
    filters.search.trim(),
    filters.limit,
  ]);
}

function purchaseOrderListError(caught: unknown): string {
  void caught;
  return 'Something went wrong. Please try again.';
}

export default function PurchaseOrdersPage() {
  return (
    <Suspense fallback={<ListSkeleton />}>
      <PurchaseOrdersInner />
    </Suspense>
  );
}

function ListSkeleton() {
  return (
    <main
      className="mx-auto max-w-7xl px-4 py-8 sm:px-6"
      data-testid="po-list-loading"
      aria-busy="true"
    >
      <SkeletonRows rows={7} />
    </main>
  );
}

function PurchaseOrdersInner() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const searchKey = searchParams.toString();
  const initialReturnToRef = useRef(`${pathname}?${searchKey}`);
  const [organizations, setOrganizations] = useState<Organization[] | null>(null);
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [farms, setFarms] = useState<Farm[]>([]);
  const [suppliers, setSuppliers] = useState<Array<{ id: string; label: string }>>([]);
  const [rows, setRows] = useState<PurchaseOrder[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [previousCursorState, setPreviousCursorState] = useState<{
    identity: string | null;
    cursors: string[];
  }>({ identity: null, cursors: [] });
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [committedViewIdentity, setCommittedViewIdentity] = useState<string | null>(null);
  const [optionsOrganizationId, setOptionsOrganizationId] = useState<string | null>(null);
  const [paginationPending, setPaginationPending] = useState(false);
  const generationRef = useRef(0);
  const optionsGenerationRef = useRef(0);
  const paginationLockRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      optionsGenerationRef.current += 1;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      apiFetch<CurrentUser>('/v1/auth/me'),
      apiFetch<Organization[]>('/v1/organizations'),
    ])
      .then(([me, orgs]) => {
        if (cancelled) return;
        setUser(me);
        setOrganizations(orgs);
        if (orgs.length === 0) router.push('/onboarding');
      })
      .catch((caught) => {
        if (cancelled) return;
        if (caught instanceof ApiError && caught.status === 401) {
          router.push(`/login?returnTo=${encodeURIComponent(initialReturnToRef.current)}`);
          return;
        }
        setError('Unable to load your organization context.');
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [router]);

  const requestedOrganizationId = searchParams.get('organization_id');
  const organizationId = useMemo(() => {
    if (!organizations?.length) return '';
    return (
      organizations.find((org) => org.id === requestedOrganizationId)?.id ?? organizations[0].id
    );
  }, [organizations, requestedOrganizationId]);
  const filters = useMemo(
    () => filtersFromSearchParams(new URLSearchParams(searchKey)),
    [searchKey],
  );
  const cursor = searchParams.get('cursor') || undefined;
  const currentScopeIdentity = useMemo(
    () => listScopeIdentity(organizationId, filters),
    [filters, organizationId],
  );
  const previousCursors =
    previousCursorState.identity === currentScopeIdentity ? previousCursorState.cursors : [];
  const currentViewIdentity = useMemo(
    () => listViewIdentity(organizationId, filters, cursor),
    [cursor, filters, organizationId],
  );
  const viewIsCurrent = committedViewIdentity === currentViewIdentity;
  const visibleRows = viewIsCurrent ? rows : [];
  const visibleNextCursor = viewIsCurrent ? nextCursor : null;
  const visibleForbidden = viewIsCurrent && forbidden;
  const contextError = organizations === null && error ? error : null;
  const visibleError = contextError ?? (viewIsCurrent ? error : null);
  const visibleLoading = !visibleError && (loading || !viewIsCurrent);
  const visibleFarms = optionsOrganizationId === organizationId ? farms : [];
  const visibleSuppliers = optionsOrganizationId === organizationId ? suppliers : [];

  useEffect(() => {
    if (!organizationId || requestedOrganizationId === organizationId) return;
    const next = new URLSearchParams();
    next.set('organization_id', organizationId);
    router.replace(`${pathname}?${next.toString()}`);
  }, [organizationId, pathname, requestedOrganizationId, router]);

  useEffect(() => {
    if (!organizationId) return;
    const generation = ++optionsGenerationRef.current;
    const controller = new AbortController();
    setFarms([]);
    setSuppliers([]);
    setOptionsOrganizationId(null);
    void Promise.allSettled([
      apiFetch<Farm[]>(`/v1/organizations/${organizationId}/farms`, { signal: controller.signal }),
      listBusinessPartners({ organizationId, capability: 'supplier', active: true, limit: 200 }),
    ]).then(([farmResult, supplierResult]) => {
      if (!mountedRef.current || generation !== optionsGenerationRef.current) return;
      if (farmResult.status === 'fulfilled') setFarms(farmResult.value);
      if (supplierResult.status === 'fulfilled') {
        setSuppliers(
          supplierResult.value.items.map((partner) => ({
            id: partner.id,
            label: `${partner.code} — ${partner.trading_name || partner.legal_name}`,
          })),
        );
      }
      setOptionsOrganizationId(organizationId);
    });
    return () => controller.abort();
  }, [organizationId]);

  const clearCursor = useCallback(() => {
    if (paginationLockRef.current) return;
    paginationLockRef.current = true;
    setPaginationPending(true);
    const next = new URLSearchParams(searchKey);
    next.delete('cursor');
    setPreviousCursorState({ identity: null, cursors: [] });
    router.replace(`${pathname}?${next.toString()}`);
  }, [pathname, router, searchKey]);

  const recoverInvalidCursor = useCallback(() => {
    const next = new URLSearchParams(searchKey);
    next.delete('cursor');
    setPreviousCursorState({ identity: null, cursors: [] });
    router.replace(`${pathname}?${next.toString()}`);
  }, [pathname, router, searchKey]);

  useEffect(() => {
    if (!organizationId || !user) return;
    const generation = ++generationRef.current;
    const controller = new AbortController();
    const isCurrent = () => mountedRef.current && generation === generationRef.current;
    setRows([]);
    setNextCursor(null);
    setLoading(true);
    setForbidden(false);
    setError(null);
    setCommittedViewIdentity(currentViewIdentity);

    if (!hasAnyReadPermission(user, organizationId)) {
      setForbidden(true);
      setLoading(false);
      return () => controller.abort();
    }

    void listPurchaseOrders({
      organizationId,
      farmId: filters.farmId || undefined,
      businessPartnerId: filters.businessPartnerId || undefined,
      statuses: filters.statuses,
      orderDateFrom: filters.orderDateFrom || undefined,
      orderDateTo: filters.orderDateTo || undefined,
      expectedDeliveryFrom: filters.expectedDeliveryFrom || undefined,
      expectedDeliveryTo: filters.expectedDeliveryTo || undefined,
      search: filters.search.trim() || undefined,
      cursor,
      limit: filters.limit,
      signal: controller.signal,
    })
      .then((page) => {
        if (!isCurrent()) return;
        setRows(page.items);
        setNextCursor(page.next_cursor);
        setCommittedViewIdentity(currentViewIdentity);
      })
      .catch((caught) => {
        if (!isCurrent() || (caught instanceof DOMException && caught.name === 'AbortError'))
          return;
        if (caught instanceof ApiError && caught.status === 401) {
          router.push(`/login?returnTo=${encodeURIComponent(`${pathname}?${searchKey}`)}`);
        } else if (caught instanceof ApiError && caught.status === 403) {
          setForbidden(true);
        } else if (caught instanceof ApiError && caught.status === 404) {
          setError('This purchase-order scope is unavailable.');
        } else if (cursor && caught instanceof ApiError && [400, 422].includes(caught.status)) {
          toast('That page link is no longer valid. Returned to the first page.', 'info');
          recoverInvalidCursor();
        } else {
          setError(purchaseOrderListError(caught));
        }
        setCommittedViewIdentity(currentViewIdentity);
      })
      .finally(() => {
        if (isCurrent()) {
          paginationLockRef.current = false;
          setPaginationPending(false);
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [
    recoverInvalidCursor,
    cursor,
    currentViewIdentity,
    filters,
    organizationId,
    pathname,
    router,
    searchKey,
    user,
  ]);

  function replaceFilters(nextFilters: PurchaseOrderFiltersValue) {
    const next = new URLSearchParams();
    next.set('organization_id', organizationId);
    if (nextFilters.farmId) next.set('farm_id', nextFilters.farmId);
    if (nextFilters.businessPartnerId)
      next.set('business_partner_id', nextFilters.businessPartnerId);
    nextFilters.statuses.forEach((status) => next.append('status', status));
    if (nextFilters.orderDateFrom) next.set('order_date_from', nextFilters.orderDateFrom);
    if (nextFilters.orderDateTo) next.set('order_date_to', nextFilters.orderDateTo);
    if (nextFilters.expectedDeliveryFrom)
      next.set('expected_delivery_from', nextFilters.expectedDeliveryFrom);
    if (nextFilters.expectedDeliveryTo)
      next.set('expected_delivery_to', nextFilters.expectedDeliveryTo);
    if (nextFilters.search.trim()) next.set('search', nextFilters.search);
    if (nextFilters.limit !== 50) next.set('limit', String(nextFilters.limit));
    generationRef.current += 1;
    setRows([]);
    setNextCursor(null);
    setPreviousCursorState({ identity: null, cursors: [] });
    paginationLockRef.current = false;
    setPaginationPending(false);
    setLoading(true);
    router.replace(`${pathname}?${next.toString()}`);
  }

  function changeOrganization(nextOrganizationId: string) {
    if (!nextOrganizationId || nextOrganizationId === organizationId) return;
    generationRef.current += 1;
    optionsGenerationRef.current += 1;
    setRows([]);
    setFarms([]);
    setSuppliers([]);
    setNextCursor(null);
    setPreviousCursorState({ identity: null, cursors: [] });
    paginationLockRef.current = false;
    setPaginationPending(false);
    setLoading(true);
    router.replace(`${pathname}?organization_id=${encodeURIComponent(nextOrganizationId)}`);
  }

  function goNext() {
    if (!nextCursor || paginationLockRef.current) return;
    paginationLockRef.current = true;
    setPaginationPending(true);
    setPreviousCursorState((existing) => ({
      identity: currentScopeIdentity,
      cursors: [
        ...(existing.identity === currentScopeIdentity ? existing.cursors : []),
        cursor || '',
      ],
    }));
    const next = new URLSearchParams(searchKey);
    next.set('cursor', nextCursor);
    router.push(`${pathname}?${next.toString()}`);
  }

  function goPrevious() {
    if (previousCursors.length === 0 || paginationLockRef.current) return;
    paginationLockRef.current = true;
    setPaginationPending(true);
    const previous = previousCursors[previousCursors.length - 1];
    setPreviousCursorState({
      identity: currentScopeIdentity,
      cursors: previousCursors.slice(0, -1),
    });
    const next = new URLSearchParams(searchKey);
    if (previous) next.set('cursor', previous);
    else next.delete('cursor');
    router.push(`${pathname}?${next.toString()}`);
  }

  const activeOrganization = organizations?.find((org) => org.id === organizationId) ?? null;
  const farmNames = useMemo(() => new Map(farms.map((farm) => [farm.id, farm.name])), [farms]);
  const permissionVisibleFarms = visibleFarms.filter((farm) =>
    hasScopedPermission(user, 'purchase_order.read', {
      organizationId,
      farmId: farm.id,
    }),
  );

  return (
    <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6" data-testid="po-list-page">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-widest text-muted-foreground">
            Release 6.0.3 · Purchasing
          </p>
          <h1 className="font-display text-3xl">Purchase orders</h1>
          {activeOrganization && (
            <p className="mt-1 text-sm text-muted-foreground">{activeOrganization.name}</p>
          )}
        </div>
        {hasApplicablePermission(user, 'purchase_order.create', organizationId, filters.farmId) && (
          <Link
            href={`/purchase-orders/new?organization_id=${encodeURIComponent(organizationId)}`}
            data-testid="po-create-link"
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
          >
            Create Purchase Order
          </Link>
        )}
        {organizations && organizations.length > 1 && (
          <label className="text-sm">
            <span className="mr-2 text-muted-foreground">Organization</span>
            <select
              data-testid="po-org-selector"
              value={organizationId}
              onChange={(event) => changeOrganization(event.target.value)}
              className="rounded-md border border-border bg-background px-3 py-2"
            >
              {organizations.map((org) => (
                <option key={org.id} value={org.id}>
                  {org.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </header>

      {organizationId && (
        <PurchaseOrderFilters
          value={filters}
          farms={permissionVisibleFarms.map((farm) => ({
            id: farm.id,
            label: `${farm.code} — ${farm.name}`,
          }))}
          suppliers={visibleSuppliers}
          onChange={replaceFilters}
          onClear={() => replaceFilters(DEFAULT_FILTERS)}
        />
      )}

      <div aria-live="polite" aria-busy={visibleLoading}>
        {visibleLoading ? (
          <div data-testid="po-list-loading">
            <SkeletonRows rows={7} />
          </div>
        ) : visibleForbidden ? (
          <ForbiddenBanner />
        ) : visibleError ? (
          <div role="alert">
            <ErrorBanner message={visibleError} />
          </div>
        ) : visibleRows.length === 0 ? (
          <EmptyState
            title="No purchase orders"
            description="No purchase orders match the current organization and filters."
          />
        ) : (
          <PurchaseOrderList rows={visibleRows} farmNames={farmNames} />
        )}
      </div>

      {!visibleLoading && !visibleForbidden && !visibleError && (cursor || visibleNextCursor) && (
        <nav className="mt-5 flex flex-wrap justify-end gap-2" aria-label="Purchase order pages">
          <button
            type="button"
            onClick={clearCursor}
            disabled={!cursor}
            data-testid="po-page-first"
            className="rounded-md border border-border px-3 py-1.5 text-sm disabled:opacity-50"
          >
            First page
          </button>
          <button
            type="button"
            onClick={goPrevious}
            disabled={previousCursors.length === 0 || paginationPending}
            data-testid="po-page-previous"
            className="rounded-md border border-border px-3 py-1.5 text-sm disabled:opacity-50"
          >
            Previous
          </button>
          <button
            type="button"
            onClick={goNext}
            disabled={!visibleNextCursor || paginationPending}
            data-testid="po-page-next"
            className="rounded-md border border-border px-3 py-1.5 text-sm disabled:opacity-50"
          >
            Next
          </button>
        </nav>
      )}
    </main>
  );
}
