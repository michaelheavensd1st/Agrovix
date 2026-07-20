'use client';

/**
 * Sprint 5.1 — Inventory Dashboard.
 *
 * Read-only operational overview of inventory for the currently
 * selected organization. Uses ONLY existing Sprint 4 inventory
 * endpoints:
 *
 *   GET /v1/organizations                             — pick org context
 *   GET /v1/organizations/{org}/warehouses            — warehouses
 *   GET /v1/organizations/{org}/inventory-items       — item catalog
 *   GET /v1/warehouses/{wh}/lots                      — lots + live balance
 *
 * Tenant isolation is enforced by the backend on every endpoint.
 * Farm-scoped warehouses are filtered server-side according to the
 * caller's role assignments — this page trusts that filter and does
 * NOT re-implement tenancy client-side.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { apiFetch, ApiError } from '@/lib/api';
import { ErrorBanner, ForbiddenBanner, Loading } from '@/components/ape-ui';
import { EmptyStateCard, friendlyError } from '@/components/ui-polish';
import {
  buildDashboardProjection,
  type DashboardInventoryItem,
  type DashboardLot,
  type DashboardOrganization,
  type DashboardProjection,
  type DashboardWarehouse,
} from '@/lib/inventory-dashboard';
import { InventoryDashboardSummaryCards } from '@/components/inventory-dashboard/summary-cards';
import { InventoryDashboardAttentionPanel } from '@/components/inventory-dashboard/attention-panel';
import { InventoryDashboardRecentActivity } from '@/components/inventory-dashboard/recent-activity';
import { InventoryDashboardQuickActions } from '@/components/inventory-dashboard/quick-actions';

interface DashboardState {
  loading: boolean;
  forbidden: boolean;
  error: string | null;
  projection: DashboardProjection | null;
  warehouses: DashboardWarehouse[];
  items: DashboardInventoryItem[];
  lots: DashboardLot[];
  nowIso: string;
}

const INITIAL_STATE: DashboardState = {
  loading: true,
  forbidden: false,
  error: null,
  projection: null,
  warehouses: [],
  items: [],
  lots: [],
  nowIso: new Date().toISOString(),
};

export default function InventoryDashboardPage() {
  const router = useRouter();
  const [orgs, setOrgs] = useState<DashboardOrganization[] | null>(null);
  const [orgId, setOrgId] = useState<string>('');
  const [state, setState] = useState<DashboardState>(INITIAL_STATE);

  // Bootstrap: load organizations, pick the first.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await apiFetch<DashboardOrganization[]>('/v1/organizations');
        if (cancelled) return;
        setOrgs(list);
        if (list.length === 0) {
          router.push('/onboarding');
          return;
        }
        setOrgId(list[0].id);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          router.push('/login');
          return;
        }
        setState((s) => ({ ...s, loading: false, error: friendlyError(err) }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  const loadDashboard = useCallback(
    async (organizationId: string) => {
      setState((s) => ({
        ...s,
        loading: true,
        forbidden: false,
        error: null,
      }));
      try {
        const [warehouses, items] = await Promise.all([
          apiFetch<DashboardWarehouse[]>(`/v1/organizations/${organizationId}/warehouses`),
          apiFetch<DashboardInventoryItem[]>(`/v1/organizations/${organizationId}/inventory-items`),
        ]);

        // Fan out lot fetches; the endpoint returns balances already.
        const lotResults = await Promise.allSettled(
          warehouses.map((wh) => apiFetch<DashboardLot[]>(`/v1/warehouses/${wh.id}/lots`)),
        );
        const lots: DashboardLot[] = [];
        let hadLotError = false;
        for (const r of lotResults) {
          if (r.status === 'fulfilled') {
            lots.push(...r.value);
          } else {
            hadLotError = true;
          }
        }

        const nowIso = new Date().toISOString();
        const projection = buildDashboardProjection({
          warehouses,
          items,
          lots,
          nowIso,
        });

        setState({
          loading: false,
          forbidden: false,
          error: hadLotError
            ? 'One or more warehouses could not be loaded. Some totals may be understated.'
            : null,
          projection,
          warehouses,
          items,
          lots,
          nowIso,
        });
      } catch (err) {
        if (err instanceof ApiError) {
          if (err.status === 401) {
            router.push('/login');
            return;
          }
          if (err.status === 403) {
            setState({ ...INITIAL_STATE, loading: false, forbidden: true });
            return;
          }
        }
        setState({
          ...INITIAL_STATE,
          loading: false,
          error: friendlyError(err),
        });
      }
    },
    [router],
  );

  useEffect(() => {
    if (!orgId) return;
    void loadDashboard(orgId);
  }, [orgId, loadDashboard]);

  const activeOrg = useMemo(() => orgs?.find((o) => o.id === orgId) ?? null, [orgs, orgId]);

  return (
    <main className="mx-auto max-w-6xl px-6 py-10" data-testid="inventory-dashboard-page">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-widest text-muted-foreground">
            Sprint 5.1 · Inventory
          </p>
          <h1 className="font-display text-3xl">Inventory dashboard</h1>
          {activeOrg && (
            <p
              className="mt-1 text-sm text-muted-foreground"
              data-testid="inventory-dashboard-org-name"
            >
              {activeOrg.name}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {orgs && orgs.length > 1 && (
            <div className="flex items-center gap-2 text-sm">
              <label className="text-muted-foreground" htmlFor="inventory-dashboard-org-selector">
                Organization
              </label>
              <select
                id="inventory-dashboard-org-selector"
                data-testid="inventory-dashboard-org-selector"
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
            href="/inventory"
            data-testid="inventory-dashboard-workspace-link"
            className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-secondary"
          >
            Open workspace
          </Link>
        </div>
      </header>

      {state.forbidden ? (
        <ForbiddenBanner />
      ) : state.loading ? (
        <Loading label="Loading inventory dashboard…" />
      ) : (
        <div className="space-y-6">
          {state.error && <ErrorBanner message={state.error} />}
          {state.projection && (
            <>
              <InventoryDashboardSummaryCards summary={state.projection.summary} />
              {state.warehouses.length === 0 && state.items.length === 0 ? (
                <EmptyStateCard
                  testId="inventory-dashboard-empty"
                  title="No inventory yet"
                  description="Add a warehouse and a few items to start tracking stock."
                  action={
                    <Link
                      href="/inventory?tab=warehouses"
                      data-testid="inventory-dashboard-empty-cta"
                      className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground"
                    >
                      Create your first warehouse
                    </Link>
                  }
                />
              ) : (
                <div className="grid gap-6 lg:grid-cols-2">
                  <InventoryDashboardAttentionPanel rows={state.projection.attention} />
                  <InventoryDashboardRecentActivity
                    rows={state.projection.recent_activity}
                    nowIso={state.nowIso}
                  />
                </div>
              )}
              <InventoryDashboardQuickActions />
            </>
          )}
        </div>
      )}
    </main>
  );
}
