'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ApiError, apiFetch } from '@/lib/api';
import type { ProductionBatch, ProductionUnit, ProductionUnitType } from '@/lib/types';
import {
  Breadcrumbs,
  EmptyState,
  ErrorBanner,
  ForbiddenBanner,
  Loading,
  StateBadge,
} from '@/components/ape-ui';

export default function UnitBatchesPage() {
  const params = useParams<{ unitId: string }>();
  const unitId = params.unitId;
  const [unit, setUnit] = useState<ProductionUnit | null>(null);
  const [type, setType] = useState<ProductionUnitType | null>(null);
  const [batches, setBatches] = useState<ProductionBatch[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [u, b, types] = await Promise.all([
          apiFetch<ProductionUnit>(`/v1/units/${unitId}`),
          apiFetch<ProductionBatch[]>(`/v1/units/${unitId}/batches`),
          apiFetch<ProductionUnitType[]>('/v1/production-unit-types'),
        ]);
        setUnit(u);
        setBatches(b);
        setType(types.find((t) => t.id === u.unit_type_id) ?? null);
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
  }, [unitId]);

  const displayLabel = type?.display_name ?? 'Unit';

  const sortedBatches = useMemo(
    () => (batches ?? []).slice().sort((a, b) => (b.code > a.code ? 1 : -1)),
    [batches],
  );

  if (forbidden)
    return (
      <main className="mx-auto max-w-5xl px-6 py-10">
        <ForbiddenBanner />
      </main>
    );

  return (
    <main className="mx-auto max-w-5xl px-6 py-10" data-testid="unit-batches-page">
      <Breadcrumbs
        items={[
          { label: 'Dashboard', href: '/dashboard' },
          { label: unit ? 'Site' : '…', href: unit ? `/sites/${unit.site_id}` : undefined },
          { label: unit ? unit.name : 'Unit' },
        ]}
      />
      <div className="mt-4">
        <p className="text-xs uppercase tracking-widest text-muted-foreground">{displayLabel}</p>
        <h1 className="font-display text-3xl">{unit?.name ?? '…'}</h1>
        {unit && (
          <p className="mt-0.5 text-sm text-muted-foreground">
            {displayLabel} · Code {unit.code} · Status {unit.status} · Capacity{' '}
            {unit.capacity ?? '—'}
          </p>
        )}
      </div>

      <h2 className="mt-8 text-lg font-semibold">Batches</h2>
      {error && (
        <div className="mt-3">
          <ErrorBanner message={error} />
        </div>
      )}
      {batches === null ? (
        <div className="mt-4">
          <Loading label="Loading batches…" />
        </div>
      ) : sortedBatches.length === 0 ? (
        <div className="mt-4">
          <EmptyState
            title="No batches yet"
            description="A batch is a stocking / planting cycle recorded against this unit."
          />
        </div>
      ) : (
        <ul className="mt-4 space-y-3" data-testid="batch-list">
          {sortedBatches.map((b) => (
            <li key={b.id}>
              <Link
                href={`/batches/${b.id}`}
                data-testid={`batch-card-${b.code}`}
                className="flex items-center justify-between rounded-2xl border border-border bg-card/60 p-4 transition hover:border-primary/40 hover:shadow-sm"
              >
                <div>
                  <p className="text-sm text-muted-foreground">Batch</p>
                  <p className="font-semibold">{b.code}</p>
                  {b.species && (
                    <p className="mt-0.5 text-xs text-muted-foreground">Species: {b.species}</p>
                  )}
                </div>
                <StateBadge state={b.state} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
