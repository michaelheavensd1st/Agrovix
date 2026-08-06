'use client';

/**
 * Release 6.0.2 — Business Partner detail route.
 *
 * Shows the partner header, capabilities, supplier profile,
 * active contacts, and permission-aware actions
 * (edit / deactivate / restore / add capability / add contact).
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useParams } from 'next/navigation';

import { apiFetch, ApiError } from '@/lib/api';
import {
  getBusinessPartner,
  addCapability,
  removeCapability,
  putSupplierProfile,
  createContact,
  deactivateContact,
  restoreContact,
  deactivateBusinessPartner,
  restoreBusinessPartner,
  type BusinessPartner,
  type BusinessPartnerCapabilityCode,
  type ContactRole,
  type PreferenceTier,
  type QualificationStatus,
  CAPABILITY_LABELS,
  CONTACT_ROLE_LABELS,
  PREFERENCE_LABELS,
  QUALIFICATION_LABELS,
} from '@/lib/business-partners';
import { hasScopedPermission } from '@/lib/permissions';
import type { CurrentUser } from '@/lib/types';

export default function BusinessPartnerDetailPage() {
  const router = useRouter();
  const params = useParams<{ partnerId: string }>();
  const partnerId = params?.partnerId ?? '';

  const [partner, setPartner] = useState<BusinessPartner | null>(null);
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!partnerId) return;
    try {
      setLoading(true);
      const p = await getBusinessPartner(partnerId);
      setPartner(p);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setError('Business Partner not found.');
      } else if (err instanceof ApiError && err.status === 403) {
        setError('You do not have permission to view this partner.');
      } else {
        setError('Failed to load partner.');
      }
    } finally {
      setLoading(false);
    }
  }, [partnerId]);

  useEffect(() => {
    void (async () => {
      try {
        const me = await apiFetch<CurrentUser>('/v1/auth/me');
        setUser(me);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          router.push('/login');
        }
      }
    })();
    void refresh();
  }, [refresh, router]);

  const orgId = partner?.organization_id ?? '';
  const canUpdate = hasScopedPermission(user, 'business_partner.update', {
    organizationId: orgId,
  });
  const canDeactivate = hasScopedPermission(user, 'business_partner.deactivate', {
    organizationId: orgId,
  });

  async function onDeactivate() {
    if (!partner) return;
    const reason = window.prompt('Reason for deactivation:');
    if (!reason || !reason.trim()) return;
    setBusy(true);
    try {
      await deactivateBusinessPartner(partner.id, reason.trim());
      await refresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to deactivate.');
    } finally {
      setBusy(false);
    }
  }

  async function onRestore() {
    if (!partner) return;
    const reason = window.prompt('Reason for restore:');
    if (!reason || !reason.trim()) return;
    setBusy(true);
    try {
      await restoreBusinessPartner(partner.id, reason.trim());
      await refresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to restore.');
    } finally {
      setBusy(false);
    }
  }

  async function onAddCapability(cap: BusinessPartnerCapabilityCode) {
    if (!partner) return;
    setBusy(true);
    try {
      await addCapability(partner.id, cap);
      await refresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to add capability.');
    } finally {
      setBusy(false);
    }
  }

  async function onRemoveCapability(cap: BusinessPartnerCapabilityCode) {
    if (!partner) return;
    if (!window.confirm(`Remove ${CAPABILITY_LABELS[cap]}?`)) return;
    setBusy(true);
    try {
      await removeCapability(partner.id, cap);
      await refresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to remove capability.');
    } finally {
      setBusy(false);
    }
  }

  async function onSaveSupplierProfile(
    qual: QualificationStatus,
    pref: PreferenceTier,
    note: string,
  ) {
    if (!partner) return;
    setBusy(true);
    try {
      await putSupplierProfile(partner.id, {
        qualification_status: qual,
        qualification_note: note || null,
        preference_tier: pref,
      });
      await refresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to save profile.');
    } finally {
      setBusy(false);
    }
  }

  async function onAddContact(fields: {
    name: string;
    role: ContactRole;
    email: string;
    phone: string;
    isPrimary: boolean;
  }) {
    if (!partner) return;
    setBusy(true);
    try {
      await createContact(partner.id, {
        name: fields.name,
        contact_role: fields.role,
        email: fields.email || null,
        phone: fields.phone || null,
        is_primary: fields.isPrimary,
      });
      await refresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to add contact.');
    } finally {
      setBusy(false);
    }
  }

  async function onDeactivateContact(contactId: string) {
    const reason = window.prompt('Reason:');
    if (!reason || !reason.trim()) return;
    setBusy(true);
    try {
      await deactivateContact(contactId, reason.trim());
      await refresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed.');
    } finally {
      setBusy(false);
    }
  }

  async function onRestoreContact(contactId: string) {
    const reason = window.prompt('Reason:');
    if (!reason || !reason.trim()) return;
    setBusy(true);
    try {
      await restoreContact(contactId, reason.trim());
      await refresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed.');
    } finally {
      setBusy(false);
    }
  }

  if (loading && !partner) {
    return <div className="px-6 py-8 text-slate-500" data-testid="bp-detail-loading">Loading…</div>;
  }
  if (error) {
    return (
      <div className="px-6 py-8">
        <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800" data-testid="bp-detail-error">
          {error}
        </div>
      </div>
    );
  }
  if (!partner) return null;

  return (
    <div className="px-6 py-8 max-w-4xl mx-auto space-y-8">
      <div>
        <Link href={`/business-partners?organization_id=${orgId}`} className="text-sm text-slate-500 hover:underline">
          ← Back to partners
        </Link>
      </div>
      <header className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold">{partner.legal_name}</h1>
            {!partner.is_active && (
              <span className="rounded bg-slate-200 px-2 py-0.5 text-xs text-slate-700" data-testid="bp-detail-inactive">
                Inactive
              </span>
            )}
          </div>
          <div className="mt-1 text-sm text-slate-500">
            <span className="font-mono">{partner.code}</span>
            {partner.trading_name && <span> · {partner.trading_name}</span>}
          </div>
        </div>
        <div className="flex gap-2">
          {canUpdate && (
            <Link
              href={`/business-partners/${partner.id}/edit`}
              data-testid="bp-detail-edit-link"
              className="rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
            >
              Edit
            </Link>
          )}
          {canDeactivate &&
            (partner.is_active ? (
              <button
                type="button"
                data-testid="bp-detail-deactivate"
                onClick={onDeactivate}
                disabled={busy}
                className="rounded border border-red-300 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50"
              >
                Deactivate
              </button>
            ) : (
              <button
                type="button"
                data-testid="bp-detail-restore"
                onClick={onRestore}
                disabled={busy}
                className="rounded border border-emerald-300 px-3 py-1.5 text-sm text-emerald-700 hover:bg-emerald-50"
              >
                Restore
              </button>
            ))}
        </div>
      </header>

      {/* Address + contact conveniences */}
      <section>
        <h2 className="text-xs font-semibold uppercase text-slate-500 mb-2">
          Primary address
        </h2>
        <div className="text-sm text-slate-700" data-testid="bp-detail-primary-address">
          {(() => {
            const a = partner.primary_address;
            if (!a) return '—';
            const parts = [a.line1, a.line2, a.city, a.region, a.postal_code, a.country_code].filter(
              Boolean,
            );
            return parts.length ? parts.join(', ') : '—';
          })()}
        </div>
        <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
          <div>
            <dt className="text-xs uppercase text-slate-500">Email</dt>
            <dd data-testid="bp-detail-email">{partner.email ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-slate-500">Phone</dt>
            <dd data-testid="bp-detail-phone">{partner.phone ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-slate-500">Country</dt>
            <dd data-testid="bp-detail-country-code">{partner.country_code ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-slate-500">Tax identifier</dt>
            <dd data-testid="bp-detail-tax-identifier">
              {partner.tax_identifier ?? '—'}
            </dd>
          </div>
        </dl>
      </section>

      {/* Capabilities */}
      <section data-testid="bp-detail-capabilities">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-xs font-semibold uppercase text-slate-500">Capabilities</h2>
        </div>
        <div className="flex flex-wrap gap-2 mb-2">
          {partner.capabilities.map((c) => (
            <span
              key={c.id}
              className="inline-flex items-center gap-2 rounded bg-slate-100 px-2 py-1 text-xs"
              data-testid={`bp-detail-capability-${c.capability}`}
            >
              {CAPABILITY_LABELS[c.capability]}
              {canUpdate && (
                <button
                  type="button"
                  onClick={() => onRemoveCapability(c.capability)}
                  className="text-slate-500 hover:text-red-600"
                  aria-label={`Remove ${CAPABILITY_LABELS[c.capability]}`}
                >
                  ×
                </button>
              )}
            </span>
          ))}
        </div>
        {canUpdate && (
          <details className="text-sm">
            <summary className="cursor-pointer text-slate-600">Add capability</summary>
            <div className="mt-2 flex flex-wrap gap-2">
              {(Object.keys(CAPABILITY_LABELS) as BusinessPartnerCapabilityCode[])
                .filter((c) => !partner.capabilities.find((x) => x.capability === c))
                .map((c) => (
                  <button
                    key={c}
                    type="button"
                    data-testid={`bp-detail-add-capability-${c}`}
                    onClick={() => onAddCapability(c)}
                    className="rounded border border-slate-300 px-2 py-0.5 text-xs hover:bg-slate-100"
                  >
                    + {CAPABILITY_LABELS[c]}
                  </button>
                ))}
            </div>
          </details>
        )}
      </section>

      {/* Supplier profile */}
      {partner.capabilities.some((c) => c.capability === 'supplier') && (
        <SupplierProfileSection
          partner={partner}
          canUpdate={canUpdate}
          onSave={onSaveSupplierProfile}
          busy={busy}
        />
      )}

      {/* Contacts */}
      <ContactsSection
        partner={partner}
        canUpdate={canUpdate}
        onAddContact={onAddContact}
        onDeactivateContact={onDeactivateContact}
        onRestoreContact={onRestoreContact}
        busy={busy}
      />

      {partner.notes && (
        <section>
          <h2 className="text-xs font-semibold uppercase text-slate-500 mb-2">Notes</h2>
          <p className="text-sm text-slate-700 whitespace-pre-wrap">{partner.notes}</p>
        </section>
      )}
    </div>
  );
}

function SupplierProfileSection({
  partner,
  canUpdate,
  onSave,
  busy,
}: {
  partner: BusinessPartner;
  canUpdate: boolean;
  onSave: (q: QualificationStatus, p: PreferenceTier, note: string) => Promise<void>;
  busy: boolean;
}) {
  const profile = partner.supplier_profile;
  const [qual, setQual] = useState<QualificationStatus>(profile?.qualification_status ?? 'unqualified');
  const [pref, setPref] = useState<PreferenceTier>(profile?.preference_tier ?? 'standard');
  const [note, setNote] = useState<string>(profile?.qualification_note ?? '');

  useEffect(() => {
    setQual(profile?.qualification_status ?? 'unqualified');
    setPref(profile?.preference_tier ?? 'standard');
    setNote(profile?.qualification_note ?? '');
  }, [profile]);

  return (
    <section data-testid="bp-detail-supplier-profile">
      <h2 className="text-xs font-semibold uppercase text-slate-500 mb-2">Supplier profile</h2>
      <div className="rounded border border-slate-200 p-4 space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-xs font-medium">Qualification</span>
            <select
              disabled={!canUpdate}
              value={qual}
              onChange={(e) => setQual(e.target.value as QualificationStatus)}
              data-testid="bp-detail-qualification"
              className="mt-1 block w-full rounded border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-100"
            >
              {Object.entries(QUALIFICATION_LABELS).map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-xs font-medium">Preference</span>
            <select
              disabled={!canUpdate}
              value={pref}
              onChange={(e) => setPref(e.target.value as PreferenceTier)}
              data-testid="bp-detail-preference"
              className="mt-1 block w-full rounded border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-100"
            >
              {Object.entries(PREFERENCE_LABELS).map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
          </label>
        </div>
        <label className="block">
          <span className="text-xs font-medium">Note</span>
          <textarea
            value={note}
            disabled={!canUpdate}
            onChange={(e) => setNote(e.target.value)}
            className="mt-1 block w-full rounded border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-100"
            rows={2}
            maxLength={2000}
          />
        </label>
        {canUpdate && (
          <div className="flex justify-end">
            <button
              type="button"
              disabled={busy}
              data-testid="bp-detail-save-supplier-profile"
              onClick={() => void onSave(qual, pref, note)}
              className="rounded bg-slate-900 px-3 py-1.5 text-sm text-white disabled:opacity-50"
            >
              Save profile
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

function ContactsSection({
  partner,
  canUpdate,
  onAddContact,
  onDeactivateContact,
  onRestoreContact,
  busy,
}: {
  partner: BusinessPartner;
  canUpdate: boolean;
  onAddContact: (f: { name: string; role: ContactRole; email: string; phone: string; isPrimary: boolean }) => Promise<void>;
  onDeactivateContact: (id: string) => Promise<void>;
  onRestoreContact: (id: string) => Promise<void>;
  busy: boolean;
}) {
  const [name, setName] = useState('');
  const [role, setRole] = useState<ContactRole>('accounts');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [isPrimary, setIsPrimary] = useState(false);

  async function submit() {
    if (!name.trim()) return;
    await onAddContact({ name: name.trim(), role, email, phone, isPrimary });
    setName(''); setEmail(''); setPhone(''); setIsPrimary(false);
  }

  return (
    <section data-testid="bp-detail-contacts">
      <h2 className="text-xs font-semibold uppercase text-slate-500 mb-2">Contacts</h2>
      <div className="rounded border border-slate-200 divide-y">
        {partner.contacts.length === 0 && (
          <div className="p-4 text-sm text-slate-500">No contacts.</div>
        )}
        {partner.contacts.map((c) => (
          <div key={c.id} className="flex items-center justify-between p-3" data-testid={`bp-contact-${c.id}`}>
            <div>
              <div className="text-sm font-medium">
                {c.name}
                {c.is_primary && (
                  <span className="ml-2 rounded bg-emerald-100 px-1.5 text-xs text-emerald-800">Primary</span>
                )}
                {!c.is_active && (
                  <span className="ml-2 rounded bg-slate-200 px-1.5 text-xs">Inactive</span>
                )}
              </div>
              <div className="text-xs text-slate-500">
                {CONTACT_ROLE_LABELS[c.contact_role]}
                {c.email ? ` · ${c.email}` : ''}
                {c.phone ? ` · ${c.phone}` : ''}
              </div>
            </div>
            {canUpdate && (
              <div className="flex gap-1">
                {c.is_active ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void onDeactivateContact(c.id)}
                    data-testid={`bp-contact-deactivate-${c.id}`}
                    className="rounded border border-red-300 px-2 py-0.5 text-xs text-red-700"
                  >
                    Deactivate
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void onRestoreContact(c.id)}
                    data-testid={`bp-contact-restore-${c.id}`}
                    className="rounded border border-emerald-300 px-2 py-0.5 text-xs text-emerald-700"
                  >
                    Restore
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {canUpdate && (
        <div className="mt-4 rounded border border-dashed border-slate-300 p-3" data-testid="bp-add-contact-form">
          <div className="grid grid-cols-2 gap-2">
            <input
              type="text"
              placeholder="Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              data-testid="bp-add-contact-name"
              className="rounded border border-slate-300 px-2 py-1 text-sm"
            />
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as ContactRole)}
              data-testid="bp-add-contact-role"
              className="rounded border border-slate-300 px-2 py-1 text-sm"
            >
              {Object.entries(CONTACT_ROLE_LABELS).map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
            <input
              type="email"
              placeholder="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="rounded border border-slate-300 px-2 py-1 text-sm"
            />
            <input
              type="tel"
              placeholder="Phone"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="rounded border border-slate-300 px-2 py-1 text-sm"
            />
          </div>
          <label className="mt-2 flex items-center gap-2 text-sm">
            <input type="checkbox" checked={isPrimary} onChange={(e) => setIsPrimary(e.target.checked)} />
            Primary for this role
          </label>
          <div className="mt-2 flex justify-end">
            <button
              type="button"
              disabled={busy || !name.trim()}
              data-testid="bp-add-contact-submit"
              onClick={() => void submit()}
              className="rounded bg-slate-900 px-3 py-1 text-sm text-white disabled:opacity-50"
            >
              Add contact
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
