'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ApiError, apiFetch } from '@/lib/api';
import type { ProductionSite, ProductionUnit, ProductionUnitType } from '@/lib/types';
import {
  Breadcrumbs,
  EmptyState,
  ErrorBanner,
  ForbiddenBanner,
  Loading,
} from '@/components/ape-ui';

export default function SiteUnitsPage() {
  const params = useParams<{ siteId: string }>();
  const siteId = params.siteId;
  const [site, setSite] = useState<ProductionSite | null>(null);
  const [units, setUnits] = useState<ProductionUnit[] | null>(null);
  const [types, setTypes] = useState<ProductionUnitType[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [s, u, t] = await Promise.all([
          apiFetch<ProductionSite>(`/v1/sites/${siteId}`),
          apiFetch<ProductionUnit[]>(`/v1/sites/${siteId}/units`),
          apiFetch<ProductionUnitType[]>('/v1/production-unit-types'),
        ]);
        setSite(s);
        setUnits(u);
        setTypes(t);
      } catch (err) {
        if (err instanceof ApiError && err.status === 403) setForbidden(true);
        else
          setError(
            err instanceof ApiError
              ? ((err.payload.detail as string) ?? 'Failed to load.')
              : String(err),
          );
      }
    })();
  }, [siteId]);

  const typeById = useMemo(() => {
    const m: Record<string, ProductionUnitType> = {};
    (types ?? []).forEach((t) => {
      m[t.id] = t;
    });
    return m;
  }, [types]);

  const grouped = useMemo(() => {
    const g: Record<string, { label: string; plural: string; items: ProductionUnit[] }> = {};
    (units ?? []).forEach((u) => {
      const t = typeById[u.unit_type_id];
      const key = t?.code ?? u.unit_type_id;
      const label = t?.display_name ?? 'Unit';
      const plural = t?.plural_name ?? `${label}s`;
      if (!g[key]) g[key] = { label, plural, items: [] };
      g[key].items.push(u);
    });
    return Object.entries(g).sort((a, b) => a[1].plural.localeCompare(b[1].plural));
  }, [units, typeById]);

  if (forbidden)
    return (
      <main className="mx-auto max-w-5xl px-6 py-10">
        <ForbiddenBanner />
      </main>
    );

  return (
    <main className="mx-auto max-w-5xl px-6 py-10" data-testid="site-units-page">
      <Breadcrumbs
        items={[
          { label: 'Dashboard', href: '/dashboard' },
          { label: site ? 'Farm' : '…', href: site ? `/farms/${site.farm_id}` : undefined },
          { label: site ? site.name : 'Site' },
        ]}
      />
      <div className="mt-4">
        <p className="text-xs uppercase tracking-widest text-muted-foreground">Site</p>
        <h1 className="font-display text-3xl">{site?.name ?? '…'}</h1>
        {site && (
          <p className="mt-0.5 text-sm text-muted-foreground">
            Code: {site.code} · Status: {site.status}
          </p>
        )}
      </div>

      {error && (
        <div className="mt-6">
          <ErrorBanner message={error} />
        </div>
      )}

      {units === null ? (
        <div className="mt-6">
          <Loading label="Loading units…" />
        </div>
      ) : units.length === 0 ? (
        <div className="mt-6">
          <EmptyState
            title="No units yet"
            description="Ponds, cages, tanks and raceways will show up here once created."
          />
        </div>
      ) : (
        grouped.map(([key, group]) => (
          <section key={key} className="mt-8">
            <h2 className="text-lg font-semibold" data-testid={`unit-group-${key}`}>
              {group.plural}
            </h2>
            <ul
              className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
              data-testid={`unit-list-${key}`}
            >
              {group.items.map((u) => (
                <li key={u.id}>
                  <Link
                    href={`/units/${u.id}`}
                    data-testid={`unit-card-${u.code}`}
                    className="block rounded-2xl border border-border bg-card/60 p-4 transition hover:border-primary/40 hover:shadow-sm"
                  >
                    <p className="text-sm text-muted-foreground">
                      {group.label} · {u.code}
                    </p>
                    <p className="mt-0.5 text-base font-semibold">{u.name}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Status: {u.status} · Capacity: {u.capacity ?? '—'}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </main>
  );
}
