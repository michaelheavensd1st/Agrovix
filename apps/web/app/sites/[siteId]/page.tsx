'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { ApiError, apiFetch } from '@/lib/api';
import type {
  CurrentUser,
  Farm,
  ProductionSite,
  ProductionUnit,
  ProductionUnitType,
} from '@/lib/types';
import {
  Breadcrumbs,
  ErrorBanner,
  ForbiddenBanner,
  Loading,
} from '@/components/ape-ui';
import { EmptyStateCard, friendlyError, toast } from '@/components/ui-polish';
import {
  ProductionUnitCreateDialog,
  type ProductionUnitCreateValues,
  type ProductionUnitFieldErrors,
} from '@/components/production-unit-create-dialog';

const VALIDATION_FIELDS = new Set<keyof ProductionUnitFieldErrors>([
  'unit_type_id',
  'name',
  'code',
  'capacity',
  'status',
]);

function validationErrors(error: ApiError): ProductionUnitFieldErrors {
  const result: ProductionUnitFieldErrors = {};
  const detail = error.payload.detail;
  if (!Array.isArray(detail)) return result;
  for (const item of detail) {
    if (!item || typeof item !== 'object') continue;
    const record = item as { loc?: unknown; msg?: unknown };
    if (!Array.isArray(record.loc)) continue;
    const field = record.loc.at(-1);
    if (
      typeof field === 'string' &&
      VALIDATION_FIELDS.has(field as keyof ProductionUnitFieldErrors)
    ) {
      result[field as keyof ProductionUnitFieldErrors] =
        typeof record.msg === 'string' ? record.msg : 'Invalid value.';
    }
  }
  return result;
}

export default function SiteUnitsPage() {
  const router = useRouter();
  const params = useParams<{ siteId: string }>();
  const siteId = params.siteId;
  const [site, setSite] = useState<ProductionSite | null>(null);
  const [units, setUnits] = useState<ProductionUnit[] | null>(null);
  const [types, setTypes] = useState<ProductionUnitType[] | null>(null);
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [typesError, setTypesError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createFieldErrors, setCreateFieldErrors] = useState<ProductionUnitFieldErrors>({});
  const loadGenerationRef = useRef(0);
  const mutationGenerationRef = useRef(0);
  const submittingRef = useRef(false);
  const siteIdRef = useRef(siteId);
  siteIdRef.current = siteId;

  useEffect(() => {
    const generation = ++loadGenerationRef.current;
    let cancelled = false;
    const isCurrent = () =>
      !cancelled && loadGenerationRef.current === generation && siteIdRef.current === siteId;
    (async () => {
      try {
        const [s, u, me] = await Promise.all([
          apiFetch<ProductionSite>(`/v1/sites/${siteId}`),
          apiFetch<ProductionUnit[]>(`/v1/sites/${siteId}/units`),
          apiFetch<CurrentUser>('/v1/auth/me'),
        ]);
        if (!isCurrent()) return;
        setSite(s);
        setUnits(u);
        setUser(me);

        try {
          const farm = await apiFetch<Farm>(`/v1/farms/${s.farm_id}`);
          const t = await apiFetch<ProductionUnitType[]>(
            `/v1/production-unit-types?organization_id=${encodeURIComponent(farm.organization_id)}`,
          );
          if (isCurrent()) setTypes(t);
        } catch (typeError) {
          if (!isCurrent()) return;
          if (typeError instanceof ApiError && typeError.status === 401) {
            router.push('/login');
            return;
          }
          setTypes([]);
          setTypesError(
            typeError instanceof ApiError && typeError.status === 403
              ? "You don't have permission to view production unit types."
              : friendlyError(typeError),
          );
        }
      } catch (err) {
        if (!isCurrent()) return;
        if (err instanceof ApiError && err.status === 401) router.push('/login');
        else if (err instanceof ApiError && err.status === 403) setForbidden(true);
        else
          setError(
            err instanceof ApiError
              ? ((err.payload.detail as string) ?? 'Failed to load.')
              : String(err),
          );
      }
    })();
    return () => {
      cancelled = true;
      loadGenerationRef.current += 1;
      mutationGenerationRef.current += 1;
      submittingRef.current = false;
    };
  }, [router, siteId]);

  const canCreate = Boolean(
    user?.is_superuser || user?.permissions.includes('production_unit.create'),
  );
  const creationDisabled = site?.status !== 'active';

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

  async function submitCreate(values: ProductionUnitCreateValues) {
    if (submittingRef.current) return;
    submittingRef.current = true;
    const generation = ++mutationGenerationRef.current;
    const capturedSiteId = siteId;
    const isCurrent = () =>
      mutationGenerationRef.current === generation && siteIdRef.current === capturedSiteId;
    setCreateBusy(true);
    setCreateError(null);
    setCreateFieldErrors({});
    try {
      const created = await apiFetch<ProductionUnit>(`/v1/sites/${siteId}/units`, {
        method: 'POST',
        body: JSON.stringify(values),
      });
      if (!isCurrent()) return;
      setUnits((current) => [...(current ?? []), created]);
      setCreating(false);
      toast(`Production unit "${created.name}" created.`, 'success');
      try {
        const refreshed = await apiFetch<ProductionUnit[]>(`/v1/sites/${capturedSiteId}/units`);
        if (isCurrent()) setUnits(refreshed);
      } catch (refreshError) {
        if (isCurrent()) {
          toast('The unit was created, but the list could not be refreshed.', 'error');
        }
      }
    } catch (err) {
      if (!isCurrent()) return;
      if (err instanceof ApiError && err.status === 401) {
        router.push('/login');
        return;
      }
      if (err instanceof ApiError && err.status === 403) {
        setCreateError("You don't have permission to create production units at this site.");
        return;
      }
      if (err instanceof ApiError && err.status === 404) {
        setCreateError('This production site no longer exists or is not accessible.');
        return;
      }
      if (err instanceof ApiError && err.status === 409) {
        setCreateFieldErrors({
          code: 'A production unit with this code already exists at the site.',
        });
        setCreateError('Choose a different unit code and try again.');
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
      <div className="mt-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-widest text-muted-foreground">Site</p>
          <h1 className="font-display text-3xl">{site?.name ?? '…'}</h1>
          {site && (
            <p className="mt-0.5 text-sm text-muted-foreground">
              Code: {site.code} · Status: {site.status}
            </p>
          )}
        </div>
        {canCreate && (
          <button
            type="button"
            data-testid="site-create-unit-header"
            onClick={openCreate}
            disabled={creationDisabled}
            title={creationDisabled ? 'Units can only be created at an active site.' : undefined}
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-60"
          >
            + Create Unit
          </button>
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
          <EmptyStateCard
            title="No units yet"
            description="Create the first pond, cage, tank, raceway, or other production unit for this site."
            action={
              canCreate ? (
                <button
                  type="button"
                  data-testid="site-create-unit-empty"
                  onClick={openCreate}
                  disabled={creationDisabled}
                  className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Create Unit
                </button>
              ) : undefined
            }
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

      <ProductionUnitCreateDialog
        open={creating}
        unitTypes={types}
        busy={createBusy}
        errorMessage={typesError ?? createError}
        fieldErrors={createFieldErrors}
        onSubmit={(values) => void submitCreate(values)}
        onClose={closeCreate}
      />
    </main>
  );
}
