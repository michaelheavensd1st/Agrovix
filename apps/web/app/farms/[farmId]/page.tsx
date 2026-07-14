'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ApiError, apiFetch } from '@/lib/api';
import type { Farm, ProductionSite } from '@/lib/types';
import {
  Breadcrumbs,
  EmptyState,
  ErrorBanner,
  ForbiddenBanner,
  Loading,
} from '@/components/ape-ui';

export default function FarmSitesPage() {
  const params = useParams<{ farmId: string }>();
  const farmId = params.farmId;
  const [farm, setFarm] = useState<Farm | null>(null);
  const [sites, setSites] = useState<ProductionSite[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [f, s] = await Promise.all([
          apiFetch<Farm>(`/v1/farms/${farmId}`),
          apiFetch<ProductionSite[]>(`/v1/farms/${farmId}/sites`),
        ]);
        setFarm(f);
        setSites(s);
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
  }, [farmId]);

  if (forbidden)
    return (
      <main className="mx-auto max-w-5xl px-6 py-10">
        <ForbiddenBanner />
      </main>
    );

  return (
    <main className="mx-auto max-w-5xl px-6 py-10" data-testid="farm-sites-page">
      <Breadcrumbs
        items={[
          { label: 'Dashboard', href: '/dashboard' },
          {
            label: farm ? `Org ${farm.organization_id.slice(0, 8)}…` : '…',
            href: farm ? `/organizations/${farm.organization_id}` : undefined,
          },
          { label: farm ? farm.name : 'Farm' },
        ]}
      />
      <div className="mt-4 flex items-center justify-between">
        <div>
          <p className="text-xs uppercase tracking-widest text-muted-foreground">Farm</p>
          <h1 className="font-display text-3xl">{farm?.name ?? '…'}</h1>
          {farm && <p className="mt-0.5 text-sm text-muted-foreground">Code: {farm.code}</p>}
        </div>
      </div>

      <h2 className="mt-8 text-lg font-semibold">Production Sites</h2>
      {error && (
        <div className="mt-3">
          <ErrorBanner message={error} />
        </div>
      )}
      {sites === null ? (
        <div className="mt-4">
          <Loading label="Loading sites…" />
        </div>
      ) : sites.length === 0 ? (
        <div className="mt-4">
          <EmptyState
            title="No sites yet"
            description="Create your first production site to begin recording activity."
          />
        </div>
      ) : (
        <ul className="mt-4 grid gap-3 sm:grid-cols-2" data-testid="site-list">
          {sites.map((s) => (
            <li key={s.id}>
              <Link
                href={`/sites/${s.id}`}
                data-testid={`site-card-${s.code}`}
                className="block rounded-2xl border border-border bg-card/60 p-5 transition hover:border-primary/40 hover:shadow-sm"
              >
                <div className="flex items-center justify-between">
                  <p className="text-lg font-semibold">{s.name}</p>
                  <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">
                    {s.status}
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">Code: {s.code}</p>
                {s.description && <p className="mt-2 text-sm">{s.description}</p>}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
