'use client';

/**
 * Sprint 5.2 — Warehouse detail route.
 *
 * `/inventory/warehouses/[warehouseId]?organization_id=…`
 *
 * Reuses the Sprint 5.1 architectural patterns end-to-end:
 *   - three request-generation refs (`detailRef`, `inventoryRef`,
 *     `activityRef`) so a stale org-A response can never damage
 *     org-B state;
 *   - centralised 401 / 403 handler (identical semantics to the
 *     Sprint 5.1 workspace);
 *   - bounded fan-out via `mapWithConcurrency(..., 5)` for the
 *     activity timeline. Never `Promise.all` over lots.
 *
 * The detail page also enforces cross-tenant safety: if the
 * warehouse the URL points at does not belong to the currently
 * active organization, we surface a scoped forbidden banner
 * rather than silently swap the org.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { apiFetch, ApiError } from '@/lib/api';
import {
  ACTIVITY_CONCURRENCY,
  buildWarehouseInventoryRows,
  inspectActivityFanOut,
  mapWithConcurrency,
  resolveOrganizationId,
  type Warehouse,
  type WarehouseInventoryItem,
  type WarehouseLedgerTx,
  type WarehouseLot,
  type WarehouseOrganization,
} from '@/lib/inventory-warehouses';
import { friendlyError, toast, ConfirmDialog } from '@/components/ui-polish';
import { ErrorBanner } from '@/components/ape-ui';
import { WarehouseHeader } from '@/components/warehouses/warehouse-header';
import { WarehouseSummary } from '@/components/warehouses/warehouse-summary';
import { WarehouseInventoryTable } from '@/components/warehouses/warehouse-inventory-table';
import { WarehouseActivityTimeline } from '@/components/warehouses/warehouse-activity-timeline';
import { WarehouseQuickActions } from '@/components/warehouses/warehouse-quick-actions';
import { WarehouseForbiddenBanner } from '@/components/warehouses/warehouse-forbidden-banner';
import { WarehouseLoadingSkeleton } from '@/components/warehouses/warehouse-loading-skeleton';
import { WarehouseForm } from '@/components/warehouses/warehouse-form';

type ForbiddenScope = 'org' | 'warehouse' | 'activity';

function readInitialOrganizationId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return new URLSearchParams(window.location.search).get('organization_id');
  } catch {
    return null;
  }
}

function apiErrorStatus(reason: unknown): number | null {
  return reason instanceof ApiError ? reason.status : null;
}

export default function WarehouseDetailPage() {
  const router = useRouter();
  const params = useParams<{ warehouseId: string }>();
  const warehouseId = params?.warehouseId ?? '';

  const [orgs, setOrgs] = useState<WarehouseOrganization[] | null>(null);
  const [orgId, setOrgId] = useState<string>('');
  const [warehouse, setWarehouse] = useState<Warehouse | null>(null);
  const [items, setItems] = useState<WarehouseInventoryItem[]>([]);
  const [lots, setLots] = useState<WarehouseLot[]>([]);
  const [activity, setActivity] = useState<WarehouseLedgerTx[]>([]);
  const [activityPartial, setActivityPartial] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingActivity, setLoadingActivity] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState<{ scope: ForbiddenScope; message: string } | null>(
    null,
  );
  const [editing, setEditing] = useState(false);
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [pendingStatus, setPendingStatus] = useState<'active' | 'closed' | null>(null);
  const [statusBusy, setStatusBusy] = useState(false);

  const detailRef = useRef(0);
  const inventoryRef = useRef(0);
  const activityRef = useRef(0);
  const requestedOrgIdRef = useRef<string | null>(null);
  if (requestedOrgIdRef.current === null && typeof window !== 'undefined') {
    requestedOrgIdRef.current = readInitialOrganizationId();
  }

  const handleAuthError = useCallback(
    (err: unknown, scope: ForbiddenScope, isCurrent: () => boolean): 'auth' | 'unhandled' => {
      if (!(err instanceof ApiError)) return 'unhandled';
      if (err.status === 401) {
        router.push('/login');
        return 'auth';
      }
      if (err.status === 403) {
        if (!isCurrent()) return 'auth';
        detailRef.current += 1;
        inventoryRef.current += 1;
        activityRef.current += 1;
        if (scope === 'org' || scope === 'warehouse') {
          setWarehouse(null);
          setItems([]);
          setLots([]);
          setActivity([]);
        }
        if (scope === 'activity') {
          setActivity([]);
        }
        const messages: Record<ForbiddenScope, string> = {
          org: "You don't have permission to view organizations.",
          warehouse: "You don't have permission to view this warehouse.",
          activity: "You don't have permission to view activity for this warehouse.",
        };
        setForbidden({ scope, message: messages[scope] });
        return 'auth';
      }
      return 'unhandled';
    },
    [router],
  );

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
        setError(friendlyError(err));
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  // Load warehouse detail + item catalog + lots. Uses two guarded
  // fetches so a slow items call cannot invalidate a fast warehouse
  // response for the same generation.
  const loadDetail = useCallback(async () => {
    if (!orgId || !warehouseId) return;
    const capturedOrgId = orgId;
    const capturedWh = warehouseId;
    const detailGen = ++detailRef.current;
    const invGen = ++inventoryRef.current;
    const isCurrent = () =>
      detailRef.current === detailGen &&
      inventoryRef.current === invGen &&
      capturedOrgId === orgId &&
      capturedWh === warehouseId;
    setLoading(true);
    setError(null);
    try {
      const [wh, catalog, lotList] = await Promise.all([
        apiFetch<Warehouse>(`/v1/warehouses/${capturedWh}`),
        apiFetch<WarehouseInventoryItem[]>(`/v1/organizations/${capturedOrgId}/inventory-items`),
        apiFetch<WarehouseLot[]>(`/v1/warehouses/${capturedWh}/lots`),
      ]);
      if (!isCurrent()) return;
      // Cross-tenant safety: if the URL warehouse belongs to another
      // org we do NOT flip the selected org. Show a scoped forbidden
      // banner so the operator can pick a valid warehouse.
      if (wh.organization_id !== capturedOrgId) {
        setWarehouse(null);
        setItems([]);
        setLots([]);
        setActivity([]);
        setForbidden({
          scope: 'warehouse',
          message: 'This warehouse belongs to a different organization.',
        });
        return;
      }
      setWarehouse(wh);
      setItems(catalog);
      setLots(lotList);
      setForbidden((f) => (f && f.scope !== 'activity' ? null : f));
    } catch (err) {
      if (handleAuthError(err, 'warehouse', isCurrent) === 'auth') return;
      if (!isCurrent()) return;
      setError(friendlyError(err));
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [orgId, warehouseId, handleAuthError]);

  // Activity fan-out (bounded concurrency).
  const loadActivity = useCallback(async () => {
    if (!lots.length) {
      setActivity([]);
      setActivityPartial(false);
      return;
    }
    const capturedOrgId = orgId;
    const capturedWh = warehouseId;
    const gen = ++activityRef.current;
    const isCurrent = () =>
      activityRef.current === gen && capturedOrgId === orgId && capturedWh === warehouseId;
    setLoadingActivity(true);
    try {
      const settled = await mapWithConcurrency(lots, ACTIVITY_CONCURRENCY, (lot) =>
        apiFetch<{ items: WarehouseLedgerTx[] }>(`/v1/lots/${lot.id}/transactions`),
      );
      if (!isCurrent()) return;
      const outcome = inspectActivityFanOut(settled, apiErrorStatus);
      if (outcome.kind === 'unauthenticated') {
        router.push('/login');
        return;
      }
      if (outcome.kind === 'forbidden') {
        activityRef.current += 1;
        setActivity([]);
        setForbidden({
          scope: 'activity',
          message: "You don't have permission to view activity for this warehouse.",
        });
        return;
      }
      setActivity(outcome.transactions);
      setActivityPartial(outcome.kind === 'partial');
      setForbidden((f) => (f?.scope === 'activity' ? null : f));
    } finally {
      if (isCurrent()) setLoadingActivity(false);
    }
  }, [lots, orgId, warehouseId, router]);

  // Reset generation refs + clear scoped state when org changes.
  useEffect(() => {
    detailRef.current += 1;
    inventoryRef.current += 1;
    activityRef.current += 1;
    setWarehouse(null);
    setItems([]);
    setLots([]);
    setActivity([]);
    setActivityPartial(false);
    setForbidden(null);
    setError(null);
    setEditing(false);
    setPendingStatus(null);
  }, [orgId]);

  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

  useEffect(() => {
    void loadActivity();
  }, [loadActivity]);

  const inventoryRows = useMemo(
    () =>
      buildWarehouseInventoryRows({
        lots,
        items,
        nowIso: new Date().toISOString(),
      }),
    [lots, items],
  );

  const activeOrg = useMemo(() => orgs?.find((o) => o.id === orgId) ?? null, [orgs, orgId]);

  // Edit + status handlers ----------------------------------------- //
  async function submitEdit(payload: {
    mode: 'edit';
    name: string;
    description: string;
    address: string;
    status: 'active' | 'maintenance' | 'closed';
  }) {
    if (!warehouse) return;
    setEditBusy(true);
    setEditError(null);
    try {
      const updated = await apiFetch<Warehouse>(`/v1/warehouses/${warehouse.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: payload.name,
          description: payload.description || null,
          address: payload.address || null,
          status: payload.status,
        }),
      });
      setWarehouse(updated);
      setEditing(false);
      toast('Warehouse updated.', 'success');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        router.push('/login');
        return;
      }
      if (err instanceof ApiError && err.status === 403) {
        setEditError("You don't have permission to edit this warehouse.");
        return;
      }
      setEditError(friendlyError(err));
    } finally {
      setEditBusy(false);
    }
  }

  async function confirmStatusChange() {
    if (!warehouse || !pendingStatus) return;
    setStatusBusy(true);
    try {
      const updated = await apiFetch<Warehouse>(`/v1/warehouses/${warehouse.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: pendingStatus }),
      });
      setWarehouse(updated);
      toast(pendingStatus === 'closed' ? 'Warehouse closed.' : 'Warehouse reopened.', 'success');
      setPendingStatus(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        router.push('/login');
        return;
      }
      if (err instanceof ApiError && err.status === 403) {
        toast("You don't have permission to change this warehouse's status.", 'error');
        setPendingStatus(null);
        return;
      }
      toast(friendlyError(err), 'error');
      setPendingStatus(null);
    } finally {
      setStatusBusy(false);
    }
  }

  // Render --------------------------------------------------------- //
  if (forbidden?.scope === 'org') {
    return (
      <main className="mx-auto max-w-6xl px-6 py-10" data-testid="warehouse-detail-page">
        <WarehouseForbiddenBanner scope="org" message={forbidden.message} />
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-6xl px-6 py-10" data-testid="warehouse-detail-page">
      {loading ? (
        <WarehouseLoadingSkeleton rows={8} testId="warehouse-detail-loading" />
      ) : forbidden?.scope === 'warehouse' ? (
        <>
          <div className="mb-4">
            <Link
              href={
                orgId
                  ? `/inventory/warehouses?organization_id=${encodeURIComponent(orgId)}`
                  : '/inventory/warehouses'
              }
              data-testid="warehouse-detail-back"
              className="text-xs uppercase tracking-widest text-muted-foreground hover:text-foreground"
            >
              ← All warehouses
            </Link>
          </div>
          <WarehouseForbiddenBanner scope="warehouse" message={forbidden.message} />
        </>
      ) : warehouse ? (
        <>
          <WarehouseHeader
            warehouse={warehouse}
            organization={activeOrg}
            onEdit={() => {
              setEditing((v) => !v);
              setEditError(null);
            }}
            onStatusChange={(next) => setPendingStatus(next)}
            editDisabled={editBusy}
          />

          {error && (
            <div className="mb-4">
              <ErrorBanner message={error} />
            </div>
          )}

          {editing && (
            <div className="mb-6">
              <WarehouseForm
                mode="edit"
                warehouse={warehouse}
                organizationName={activeOrg?.name ?? null}
                busy={editBusy}
                errorMessage={editError}
                onCancel={() => {
                  setEditing(false);
                  setEditError(null);
                }}
                onSubmit={(payload) => {
                  if (payload.mode === 'edit') void submitEdit(payload);
                }}
              />
            </div>
          )}

          <div className="grid gap-6 lg:grid-cols-3">
            <div className="lg:col-span-2 space-y-6">
              <WarehouseSummary warehouse={warehouse} organization={activeOrg} />
              <section>
                <h2 className="mb-3 font-display text-lg">Inventory</h2>
                <WarehouseInventoryTable rows={inventoryRows} />
              </section>
              {forbidden?.scope === 'activity' ? (
                <WarehouseForbiddenBanner scope="activity" message={forbidden.message} />
              ) : loadingActivity ? (
                <WarehouseLoadingSkeleton rows={4} testId="warehouse-activity-loading" />
              ) : (
                <WarehouseActivityTimeline transactions={activity} partial={activityPartial} />
              )}
            </div>
            <div className="space-y-6">
              <WarehouseQuickActions warehouse={warehouse} organizationId={orgId || null} />
            </div>
          </div>

          <ConfirmDialog
            open={pendingStatus !== null}
            busy={statusBusy}
            destructive={pendingStatus === 'closed'}
            testId="warehouse-detail-status-confirm"
            title={pendingStatus === 'closed' ? 'Close warehouse?' : 'Reopen warehouse?'}
            description={
              pendingStatus === 'closed'
                ? 'Operators will not be able to receive, issue or transfer stock from this warehouse until it is reopened.'
                : 'Operators will regain access to receive, issue and transfer stock in this warehouse.'
            }
            confirmLabel={pendingStatus === 'closed' ? 'Close warehouse' : 'Reopen warehouse'}
            onConfirm={confirmStatusChange}
            onCancel={() => setPendingStatus(null)}
          />
        </>
      ) : (
        <div data-testid="warehouse-detail-not-found">
          {error ? <ErrorBanner message={error} /> : null}
        </div>
      )}
    </main>
  );
}
