'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { ApiError, apiFetch } from '@/lib/api';
import type {
  CurrentUser,
  ProductionBatch,
  ProductionSite,
  ProductionUnit,
  ProductionUnitType,
} from '@/lib/types';
import {
  Breadcrumbs,
  ErrorBanner,
  ForbiddenBanner,
  Loading,
  StateBadge,
} from '@/components/ape-ui';
import { EmptyStateCard, friendlyError, toast } from '@/components/ui-polish';
import {
  ProductionBatchCreateDialog,
  type ProductionBatchCreateValues,
  type ProductionBatchFieldErrors,
} from '@/components/production-batch-create-dialog';

const VALIDATION_FIELDS = new Set<keyof ProductionBatchFieldErrors>([
  'code',
  'species',
  'planned_at',
  'expected_quantity',
  'notes',
]);

function validationErrors(error: ApiError): ProductionBatchFieldErrors {
  const result: ProductionBatchFieldErrors = {};
  const detail = error.payload.detail;
  if (!Array.isArray(detail)) return result;
  for (const item of detail) {
    if (!item || typeof item !== 'object') continue;
    const record = item as { loc?: unknown; msg?: unknown };
    if (!Array.isArray(record.loc)) continue;
    const field = record.loc.at(-1);
    if (
      typeof field === 'string' &&
      VALIDATION_FIELDS.has(field as keyof ProductionBatchFieldErrors)
    ) {
      result[field as keyof ProductionBatchFieldErrors] =
        typeof record.msg === 'string' ? record.msg : 'Invalid value.';
    }
  }
  return result;
}

const LIFECYCLE_CONFLICTS: Record<string, string> = {
  unit_under_maintenance: 'This unit is under maintenance and cannot accept a new batch.',
  unit_closed_no_writes: 'This unit is closed and cannot accept a new batch.',
  site_under_maintenance: 'This site is under maintenance and cannot accept a new batch.',
  site_closed_no_writes: 'This site is closed and cannot accept a new batch.',
};

export default function UnitBatchesPage() {
  const router = useRouter();
  const params = useParams<{ unitId: string }>();
  const unitId = params.unitId;
  const [unit, setUnit] = useState<ProductionUnit | null>(null);
  const [site, setSite] = useState<ProductionSite | null>(null);
  const [type, setType] = useState<ProductionUnitType | null>(null);
  const [batches, setBatches] = useState<ProductionBatch[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [creating, setCreating] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createFieldErrors, setCreateFieldErrors] = useState<ProductionBatchFieldErrors>({});
  const loadGenerationRef = useRef(0);
  const mutationGenerationRef = useRef(0);
  const submittingRef = useRef(false);
  const unitIdRef = useRef(unitId);
  unitIdRef.current = unitId;

  useEffect(() => {
    const generation = ++loadGenerationRef.current;
    let cancelled = false;
    const isCurrent = () =>
      !cancelled && loadGenerationRef.current === generation && unitIdRef.current === unitId;
    (async () => {
      try {
        const [u, b, types, me] = await Promise.all([
          apiFetch<ProductionUnit>(`/v1/units/${unitId}`),
          apiFetch<ProductionBatch[]>(`/v1/units/${unitId}/batches`),
          apiFetch<ProductionUnitType[]>('/v1/production-unit-types'),
          apiFetch<CurrentUser>('/v1/auth/me'),
        ]);
        const parentSite = await apiFetch<ProductionSite>(`/v1/sites/${u.site_id}`);
        if (!isCurrent()) return;
        setUnit(u);
        setSite(parentSite);
        setBatches(b);
        setUser(me);
        setType(types.find((t) => t.id === u.unit_type_id) ?? null);
      } catch (err) {
        if (!isCurrent()) return;
        if (err instanceof ApiError && err.status === 401) router.push('/login');
        else if (err instanceof ApiError && err.status === 403) setForbidden(true);
        else setError(friendlyError(err));
      }
    })();
    return () => {
      cancelled = true;
      loadGenerationRef.current += 1;
      mutationGenerationRef.current += 1;
      submittingRef.current = false;
    };
  }, [router, unitId]);

  const canCreate = Boolean(
    user?.is_superuser || user?.permissions.includes('production_batch.create'),
  );
  const creationDisabled = unit?.status !== 'active' || site?.status !== 'active';
  const creationDisabledReason =
    unit?.status !== 'active'
      ? 'Batches can only be created in an active unit.'
      : site?.status !== 'active'
        ? 'Batches can only be created at an active site.'
        : undefined;

  const openCreate = useCallback(() => {
    setCreateError(null);
    setCreateFieldErrors({});
    setCreating(true);
  }, []);

  const closeCreate = useCallback(() => {
    setCreating(false);
    setCreateError(null);
    setCreateFieldErrors({});
  }, []);

  async function submitCreate(values: ProductionBatchCreateValues) {
    if (submittingRef.current) return;
    submittingRef.current = true;
    const generation = ++mutationGenerationRef.current;
    const capturedUnitId = unitId;
    const isCurrent = () =>
      mutationGenerationRef.current === generation && unitIdRef.current === capturedUnitId;
    setCreateBusy(true);
    setCreateError(null);
    setCreateFieldErrors({});
    try {
      const created = await apiFetch<ProductionBatch>(`/v1/units/${capturedUnitId}/batches`, {
        method: 'POST',
        body: JSON.stringify(values),
      });
      if (!isCurrent()) return;
      setBatches((current) => [...(current ?? []), created]);
      setCreating(false);
      toast(`Production batch "${created.code}" created.`, 'success');
      try {
        const refreshed = await apiFetch<ProductionBatch[]>(`/v1/units/${capturedUnitId}/batches`);
        if (isCurrent()) setBatches(refreshed);
      } catch {
        if (isCurrent()) {
          toast('The batch was created, but the list could not be refreshed.', 'error');
        }
      }
    } catch (err) {
      if (!isCurrent()) return;
      if (err instanceof ApiError && err.status === 401) {
        router.push('/login');
        return;
      }
      if (err instanceof ApiError && err.status === 403) {
        setCreateError("You don't have permission to create production batches in this unit.");
        return;
      }
      if (err instanceof ApiError && err.status === 404) {
        setCreateError('This production unit is not available.');
        return;
      }
      if (err instanceof ApiError && err.status === 409) {
        const detail = err.payload.detail;
        const code =
          detail && typeof detail === 'object' && 'code' in detail
            ? String((detail as { code: unknown }).code)
            : '';
        if (LIFECYCLE_CONFLICTS[code]) {
          setCreateError(LIFECYCLE_CONFLICTS[code]);
        } else {
          setCreateFieldErrors({ code: 'A batch with this code already exists in the unit.' });
          setCreateError('Choose a different batch code and try again.');
        }
        return;
      }
      if (err instanceof ApiError && err.status === 422) {
        const fields = validationErrors(err);
        setCreateFieldErrors(fields);
        setCreateError(
          Object.keys(fields).length > 0
            ? 'Correct the highlighted fields and try again.'
            : 'The server rejected one or more values. Review the form and try again.',
        );
        return;
      }
      setCreateError(friendlyError(err));
    } finally {
      if (isCurrent()) {
        submittingRef.current = false;
        setCreateBusy(false);
      }
    }
  }

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
      <div className="mt-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-widest text-muted-foreground">{displayLabel}</p>
          <h1 className="font-display text-3xl">{unit?.name ?? '…'}</h1>
          {unit && (
            <p className="mt-0.5 text-sm text-muted-foreground">
              {displayLabel} · Code {unit.code} · Status {unit.status} · Capacity{' '}
              {unit.capacity ?? '—'}
            </p>
          )}
        </div>
        {canCreate && (
          <button
            type="button"
            data-testid="unit-create-batch-header"
            onClick={openCreate}
            disabled={creationDisabled}
            title={creationDisabledReason}
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-60"
          >
            + Create Batch
          </button>
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
          <EmptyStateCard
            title="No batches yet"
            description="A batch is a stocking / planting cycle recorded against this unit."
            action={
              canCreate ? (
                <button
                  type="button"
                  data-testid="unit-create-batch-empty"
                  onClick={openCreate}
                  disabled={creationDisabled}
                  title={creationDisabledReason}
                  className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Create Batch
                </button>
              ) : undefined
            }
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

      <ProductionBatchCreateDialog
        open={creating}
        busy={createBusy}
        errorMessage={createError}
        fieldErrors={createFieldErrors}
        onSubmit={(values) => void submitCreate(values)}
        onClose={closeCreate}
      />
    </main>
  );
}
