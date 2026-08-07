'use client';

/**
 * Release 6.0.2 — Business Partner list route.
 *
 * `/business-partners` renders every partner belonging to the
 * active organization. The list is supplier-oriented BY DEFAULT
 * (capability filter pre-selected to ``supplier``) per §14.1 of
 * the frozen architecture — the backend model stays general.
 *
 * Every state described in §14.1 is handled explicitly:
 * loading, empty (org has zero partners), forbidden (403),
 * unavailable (tenant-hidden 404), tenant switch (stale request
 * guard via generation ref), pagination (cursor).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

import { apiFetch, ApiError } from '@/lib/api';
import {
  listBusinessPartners,
  type BusinessPartner,
  type BusinessPartnerCapabilityCode,
  type QualificationStatus,
  type PreferenceTier,
  CAPABILITY_LABELS,
  QUALIFICATION_LABELS,
  PREFERENCE_LABELS,
} from '@/lib/business-partners';
import { hasScopedPermission } from '@/lib/permissions';
import type { CurrentUser } from '@/lib/types';

function readInitialOrgId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return new URLSearchParams(window.location.search).get('organization_id');
  } catch {
    return null;
  }
}

interface OrgOption {
  id: string;
  name: string;
}

export default function BusinessPartnersListPage() {
  const router = useRouter();
  const [orgId, setOrgId] = useState<string>('');
  const [orgs, setOrgs] = useState<OrgOption[]>([]);
  const [user, setUser] = useState<CurrentUser | null>(null);

  const [rows, setRows] = useState<BusinessPartner[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [prevCursors, setPrevCursors] = useState<string[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);

  const [capability, setCapability] = useState<BusinessPartnerCapabilityCode | ''>('supplier');
  const [active, setActive] = useState<'all' | 'true' | 'false'>('all');
  const [qualification, setQualification] = useState<QualificationStatus | ''>('');
  const [preference, setPreference] = useState<PreferenceTier | ''>('');
  const [search, setSearch] = useState('');

  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const genRef = useRef(0);

  // Load bootstrap: current user + organizations.
  useEffect(() => {
    void (async () => {
      try {
        const [me, myOrgs] = await Promise.all([
          apiFetch<CurrentUser>('/v1/auth/me').catch((err) => {
            if (err instanceof ApiError && err.status === 401) {
              router.push('/login');
            }
            return null;
          }),
          apiFetch<OrgOption[]>('/v1/organizations').catch(() => [] as OrgOption[]),
        ]);
        if (!me) {
          return;
        }
        setUser(me);
        const list: OrgOption[] = Array.isArray(myOrgs) ? myOrgs : [];
        setOrgs(list);
        const requested = readInitialOrgId();
        const initial = list.find((o) => o.id === requested)?.id ?? list[0]?.id ?? '';
        setOrgId(initial);
      } catch {
        setError('Failed to load organizations.');
        setLoading(false);
      }
    })();
  }, [router]);

  const fetchList = useCallback(
    async (nextCursorArg?: string) => {
      if (!orgId) return;
      const gen = ++genRef.current;
      setLoading(true);
      setError(null);
      setForbidden(false);
      try {
        const page = await listBusinessPartners({
          organizationId: orgId,
          capability: capability || undefined,
          active: active === 'all' ? undefined : active === 'true',
          qualification: qualification || undefined,
          preference: preference || undefined,
          search: search.trim() || undefined,
          cursor: nextCursorArg,
        });
        if (gen !== genRef.current) return; // stale — org switched
        setRows(page.items);
        setNextCursor(page.next_cursor);
      } catch (err) {
        if (gen !== genRef.current) return;
        if (err instanceof ApiError) {
          if (err.status === 403) setForbidden(true);
          else if (err.status === 404) setError('This organization is unavailable.');
          else setError(err.message);
        } else {
          setError('Failed to load business partners.');
        }
      } finally {
        if (gen === genRef.current) setLoading(false);
      }
    },
    [orgId, capability, active, qualification, preference, search],
  );

  useEffect(() => {
    setCursor(undefined);
    setPrevCursors([]);
    void fetchList(undefined);
  }, [fetchList]);

  const canCreate = hasScopedPermission(user, 'business_partner.create', {
    organizationId: orgId,
  });

  return (
    <div className="px-6 py-8 max-w-7xl mx-auto">
      <header className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-semibold">Business Partners</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Suppliers, customers, contractors, and other partners for this organization.
          </p>
        </div>
        {canCreate && orgId && (
          <Link
            href={`/business-partners/new?organization_id=${orgId}`}
            data-testid="bp-create-link"
            className="inline-flex items-center rounded-md bg-slate-900 px-4 py-2 text-sm text-white hover:bg-slate-800"
          >
            New partner
          </Link>
        )}
      </header>

      {/* Organization switcher */}
      {orgs.length > 1 && (
        <div className="mb-4">
          <label className="text-xs font-medium text-slate-600">Organization</label>
          <select
            data-testid="bp-org-select"
            value={orgId}
            onChange={(e) => {
              setOrgId(e.target.value);
              const url = new URL(window.location.href);
              url.searchParams.set('organization_id', e.target.value);
              window.history.replaceState(null, '', url.toString());
            }}
            className="mt-1 block rounded border border-slate-300 px-3 py-2 text-sm"
          >
            {orgs.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Filters */}
      <section className="grid grid-cols-1 md:grid-cols-5 gap-3 mb-4" data-testid="bp-filters">
        <input
          type="text"
          placeholder="Search code, legal name, trading name…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          data-testid="bp-filter-search"
          className="rounded border border-slate-300 px-3 py-2 text-sm md:col-span-2"
        />
        <select
          value={capability}
          onChange={(e) => setCapability(e.target.value as BusinessPartnerCapabilityCode | '')}
          data-testid="bp-filter-capability"
          className="rounded border border-slate-300 px-3 py-2 text-sm"
        >
          <option value="">All capabilities</option>
          {Object.entries(CAPABILITY_LABELS).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <select
          value={active}
          onChange={(e) => setActive(e.target.value as 'all' | 'true' | 'false')}
          data-testid="bp-filter-active"
          className="rounded border border-slate-300 px-3 py-2 text-sm"
        >
          <option value="all">All</option>
          <option value="true">Active only</option>
          <option value="false">Inactive only</option>
        </select>
        <select
          value={qualification}
          onChange={(e) => setQualification(e.target.value as QualificationStatus | '')}
          data-testid="bp-filter-qualification"
          className="rounded border border-slate-300 px-3 py-2 text-sm"
        >
          <option value="">Any qualification</option>
          {Object.entries(QUALIFICATION_LABELS).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <select
          value={preference}
          onChange={(e) => setPreference(e.target.value as PreferenceTier | '')}
          data-testid="bp-filter-preference"
          className="rounded border border-slate-300 px-3 py-2 text-sm md:col-span-1"
        >
          <option value="">Any preference</option>
          {Object.entries(PREFERENCE_LABELS).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </section>

      {/* Body */}
      {loading ? (
        <div className="py-16 text-center text-sm text-slate-500" data-testid="bp-loading">
          Loading business partners…
        </div>
      ) : forbidden ? (
        <div
          className="rounded border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900"
          data-testid="bp-forbidden"
        >
          You do not have permission to view business partners in this organization.
        </div>
      ) : error ? (
        <div
          className="rounded border border-red-300 bg-red-50 p-4 text-sm text-red-800"
          data-testid="bp-error"
        >
          {error}
        </div>
      ) : rows.length === 0 ? (
        <div
          className="rounded border border-dashed border-slate-300 p-10 text-center text-sm text-slate-500"
          data-testid="bp-empty"
        >
          No business partners match these filters.
        </div>
      ) : (
        <div className="overflow-x-auto rounded border border-slate-200" data-testid="bp-table">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
              <tr>
                <th className="px-3 py-2">Code</th>
                <th className="px-3 py-2">Legal name</th>
                <th className="px-3 py-2">Capabilities</th>
                <th className="px-3 py-2">Qualification</th>
                <th className="px-3 py-2">Preference</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr
                  key={p.id}
                  className="border-t hover:bg-slate-50"
                  data-testid={`bp-row-${p.code}`}
                >
                  <td className="px-3 py-2 font-mono text-xs">{p.code}</td>
                  <td className="px-3 py-2">
                    <div className="font-medium">{p.legal_name}</div>
                    {p.trading_name && (
                      <div className="text-xs text-slate-500">{p.trading_name}</div>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      {p.capabilities.map((c) => (
                        <span
                          key={c.id}
                          className="inline-flex rounded bg-slate-100 px-2 py-0.5 text-xs"
                        >
                          {CAPABILITY_LABELS[c.capability]}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    {p.supplier_profile
                      ? QUALIFICATION_LABELS[p.supplier_profile.qualification_status]
                      : '—'}
                  </td>
                  <td className="px-3 py-2">
                    {p.supplier_profile
                      ? PREFERENCE_LABELS[p.supplier_profile.preference_tier]
                      : '—'}
                  </td>
                  <td className="px-3 py-2">
                    {p.is_active ? (
                      <span className="rounded bg-emerald-100 px-2 py-0.5 text-xs text-emerald-800">
                        Active
                      </span>
                    ) : (
                      <span
                        className="rounded bg-slate-200 px-2 py-0.5 text-xs text-slate-700"
                        data-testid={`bp-inactive-${p.code}`}
                      >
                        Inactive
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Link
                      href={`/business-partners/${p.id}`}
                      data-testid={`bp-open-${p.code}`}
                      className="text-slate-700 hover:underline"
                    >
                      Open
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      <div className="mt-4 flex items-center justify-between text-sm">
        <button
          type="button"
          disabled={prevCursors.length === 0}
          data-testid="bp-prev"
          onClick={() => {
            const stack = [...prevCursors];
            const previous = stack.pop();
            setPrevCursors(stack);
            setCursor(previous);
            void fetchList(previous);
          }}
          className="rounded border border-slate-300 px-3 py-1 disabled:opacity-40"
        >
          Previous
        </button>
        <button
          type="button"
          disabled={!nextCursor}
          data-testid="bp-next"
          onClick={() => {
            if (!nextCursor) return;
            setPrevCursors((s) => [...s, cursor ?? '']);
            setCursor(nextCursor);
            void fetchList(nextCursor);
          }}
          className="rounded border border-slate-300 px-3 py-1 disabled:opacity-40"
        >
          Next
        </button>
      </div>
    </div>
  );
}
