'use client';

/**
 * Release 6.0.2 — Create a new Business Partner.
 *
 * Supplier-oriented default: the ``supplier`` capability is
 * pre-selected and a supplier-profile section is shown. The API
 * remains general — the user may check other capabilities before
 * submitting.
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

import { ApiError } from '@/lib/api';
import {
  createBusinessPartner,
  type BusinessPartnerCapabilityCode,
  type ContactRole,
  type PreferenceTier,
  type QualificationStatus,
  CAPABILITY_LABELS,
  CONTACT_ROLE_LABELS,
  PREFERENCE_LABELS,
  QUALIFICATION_LABELS,
} from '@/lib/business-partners';

function readOrgId(): string {
  if (typeof window === 'undefined') return '';
  return new URLSearchParams(window.location.search).get('organization_id') ?? '';
}

export default function NewBusinessPartnerPage() {
  const router = useRouter();
  const orgId = useMemo(() => readOrgId(), []);

  const [code, setCode] = useState('');
  const [legalName, setLegalName] = useState('');
  const [tradingName, setTradingName] = useState('');
  const [addressLine1, setAddressLine1] = useState('');
  const [addressLine2, setAddressLine2] = useState('');
  const [city, setCity] = useState('');
  const [region, setRegion] = useState('');
  const [postalCode, setPostalCode] = useState('');
  const [addressCountryCode, setAddressCountryCode] = useState('');
  const [partnerCountryCode, setPartnerCountryCode] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [taxIdentifier, setTaxIdentifier] = useState('');
  const [notes, setNotes] = useState('');

  const [capabilities, setCapabilities] = useState<Set<BusinessPartnerCapabilityCode>>(
    new Set(['supplier']),
  );
  const [qualStatus, setQualStatus] = useState<QualificationStatus>('unqualified');
  const [preference, setPreference] = useState<PreferenceTier>('standard');
  const [qualNote, setQualNote] = useState('');

  const [contactName, setContactName] = useState('');
  const [contactRole, setContactRole] = useState<ContactRole>('accounts');
  const [contactEmail, setContactEmail] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [contactIsPrimary, setContactIsPrimary] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!orgId) {
      setError('Missing organization_id. Return to the list and re-open.');
    }
  }, [orgId]);

  const supplierChecked = capabilities.has('supplier');

  async function onSubmit(evt: React.FormEvent) {
    evt.preventDefault();
    if (!orgId) return;
    setSubmitting(true);
    setError(null);
    try {
      const trimmedLine1 = addressLine1.trim();
      const trimmedLine2 = addressLine2.trim();
      const trimmedCity = city.trim();
      const trimmedRegion = region.trim();
      const trimmedPostal = postalCode.trim();
      const trimmedAddrCC = addressCountryCode.trim().toUpperCase();
      const anyAddress =
        trimmedLine1 ||
        trimmedLine2 ||
        trimmedCity ||
        trimmedRegion ||
        trimmedPostal ||
        trimmedAddrCC;
      const partner = await createBusinessPartner(orgId, {
        code: code.trim().toUpperCase(),
        legal_name: legalName.trim(),
        trading_name: tradingName.trim() || null,
        primary_address: anyAddress
          ? {
              line1: trimmedLine1 || null,
              line2: trimmedLine2 || null,
              city: trimmedCity || null,
              region: trimmedRegion || null,
              postal_code: trimmedPostal || null,
              country_code: trimmedAddrCC || null,
            }
          : null,
        email: email.trim() || null,
        phone: phone.trim() || null,
        country_code: partnerCountryCode.trim().toUpperCase() || null,
        tax_identifier: taxIdentifier.trim() || null,
        notes: notes.trim() || null,
        capabilities: Array.from(capabilities),
        supplier_profile: supplierChecked
          ? {
              qualification_status: qualStatus,
              qualification_note: qualNote.trim() || null,
              preference_tier: preference,
            }
          : null,
        contacts: contactName.trim()
          ? [
              {
                name: contactName.trim(),
                email: contactEmail.trim() || null,
                phone: contactPhone.trim() || null,
                contact_role: contactRole,
                is_primary: contactIsPrimary,
              },
            ]
          : [],
      });
      router.push(`/business-partners/${partner.id}`);
    } catch (err) {
      if (err instanceof ApiError) {
        const detail = err.payload?.detail;
        if (typeof detail === 'object' && detail !== null && 'message' in detail) {
          setError(String((detail as { message: string }).message));
        } else {
          setError(typeof detail === 'string' ? detail : err.message);
        }
      } else {
        setError('Failed to create partner.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="px-6 py-8 max-w-3xl mx-auto">
      <div className="mb-4">
        <Link
          href={`/business-partners?organization_id=${orgId}`}
          className="text-sm text-slate-500 hover:underline"
        >
          ← Back to partners
        </Link>
      </div>
      <h1 className="text-2xl font-semibold mb-6">New Business Partner</h1>

      <form onSubmit={onSubmit} data-testid="bp-create-form" className="space-y-6">
        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase text-slate-500">Identity</h2>
          <label className="block">
            <span className="text-xs font-medium">Code</span>
            <input
              type="text"
              required
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              data-testid="bp-create-code"
              className="mt-1 block w-full rounded border border-slate-300 px-3 py-2 font-mono text-sm"
              maxLength={64}
              placeholder="ACME-01"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium">Legal name</span>
            <input
              type="text"
              required
              value={legalName}
              onChange={(e) => setLegalName(e.target.value)}
              data-testid="bp-create-legal-name"
              className="mt-1 block w-full rounded border border-slate-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium">Trading name (optional)</span>
            <input
              type="text"
              value={tradingName}
              onChange={(e) => setTradingName(e.target.value)}
              className="mt-1 block w-full rounded border border-slate-300 px-3 py-2 text-sm"
            />
          </label>
        </section>

        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase text-slate-500">Primary address</h2>
          <input
            type="text"
            placeholder="Address line 1"
            value={addressLine1}
            onChange={(e) => setAddressLine1(e.target.value)}
            data-testid="bp-create-addr-line1"
            className="block w-full rounded border border-slate-300 px-3 py-2 text-sm"
          />
          <input
            type="text"
            placeholder="Address line 2 (optional)"
            value={addressLine2}
            onChange={(e) => setAddressLine2(e.target.value)}
            data-testid="bp-create-addr-line2"
            className="block w-full rounded border border-slate-300 px-3 py-2 text-sm"
          />
          <div className="grid grid-cols-2 gap-3">
            <input
              type="text"
              placeholder="City"
              value={city}
              onChange={(e) => setCity(e.target.value)}
              data-testid="bp-create-addr-city"
              className="rounded border border-slate-300 px-3 py-2 text-sm"
            />
            <input
              type="text"
              placeholder="Region / state"
              value={region}
              onChange={(e) => setRegion(e.target.value)}
              data-testid="bp-create-addr-region"
              className="rounded border border-slate-300 px-3 py-2 text-sm"
            />
            <input
              type="text"
              placeholder="Postal code"
              value={postalCode}
              onChange={(e) => setPostalCode(e.target.value)}
              data-testid="bp-create-addr-postal"
              className="rounded border border-slate-300 px-3 py-2 text-sm"
            />
            <input
              type="text"
              placeholder="Country (ISO 3166-1 α-2)"
              maxLength={2}
              value={addressCountryCode}
              onChange={(e) => setAddressCountryCode(e.target.value.toUpperCase())}
              data-testid="bp-create-addr-country-code"
              className="rounded border border-slate-300 px-3 py-2 font-mono text-sm uppercase"
            />
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase text-slate-500">
            Header contact conveniences
          </h2>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs font-medium">Email</span>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                data-testid="bp-create-email"
                className="mt-1 block w-full rounded border border-slate-300 px-3 py-2 text-sm"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium">Phone</span>
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                data-testid="bp-create-phone"
                className="mt-1 block w-full rounded border border-slate-300 px-3 py-2 text-sm"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium">Country (ISO α-2)</span>
              <input
                type="text"
                maxLength={2}
                value={partnerCountryCode}
                onChange={(e) => setPartnerCountryCode(e.target.value.toUpperCase())}
                data-testid="bp-create-country-code"
                className="mt-1 block w-full rounded border border-slate-300 px-3 py-2 font-mono text-sm uppercase"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium">Tax identifier</span>
              <input
                type="text"
                value={taxIdentifier}
                onChange={(e) => setTaxIdentifier(e.target.value)}
                data-testid="bp-create-tax-identifier"
                className="mt-1 block w-full rounded border border-slate-300 px-3 py-2 text-sm"
              />
            </label>
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase text-slate-500">Capabilities</h2>
          <div className="grid grid-cols-2 gap-2">
            {(Object.keys(CAPABILITY_LABELS) as BusinessPartnerCapabilityCode[]).map((c) => (
              <label key={c} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  data-testid={`bp-create-capability-${c}`}
                  checked={capabilities.has(c)}
                  onChange={(e) => {
                    const next = new Set(capabilities);
                    if (e.target.checked) next.add(c);
                    else next.delete(c);
                    setCapabilities(next);
                  }}
                />
                {CAPABILITY_LABELS[c]}
              </label>
            ))}
          </div>
        </section>

        {supplierChecked && (
          <section className="space-y-3" data-testid="bp-create-supplier-profile">
            <h2 className="text-sm font-semibold uppercase text-slate-500">
              Supplier profile
            </h2>
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-xs font-medium">Qualification</span>
                <select
                  value={qualStatus}
                  onChange={(e) => setQualStatus(e.target.value as QualificationStatus)}
                  data-testid="bp-create-qualification"
                  className="mt-1 block w-full rounded border border-slate-300 px-3 py-2 text-sm"
                >
                  {Object.entries(QUALIFICATION_LABELS).map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-xs font-medium">Preference</span>
                <select
                  value={preference}
                  onChange={(e) => setPreference(e.target.value as PreferenceTier)}
                  data-testid="bp-create-preference"
                  className="mt-1 block w-full rounded border border-slate-300 px-3 py-2 text-sm"
                >
                  {Object.entries(PREFERENCE_LABELS).map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="block">
              <span className="text-xs font-medium">Qualification note (optional)</span>
              <textarea
                value={qualNote}
                onChange={(e) => setQualNote(e.target.value)}
                className="mt-1 block w-full rounded border border-slate-300 px-3 py-2 text-sm"
                rows={2}
                maxLength={2000}
              />
            </label>
          </section>
        )}

        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase text-slate-500">
            Initial contact (optional)
          </h2>
          <div className="grid grid-cols-2 gap-3">
            <input
              type="text"
              placeholder="Full name"
              value={contactName}
              onChange={(e) => setContactName(e.target.value)}
              data-testid="bp-create-contact-name"
              className="rounded border border-slate-300 px-3 py-2 text-sm"
            />
            <select
              value={contactRole}
              onChange={(e) => setContactRole(e.target.value as ContactRole)}
              data-testid="bp-create-contact-role"
              className="rounded border border-slate-300 px-3 py-2 text-sm"
            >
              {Object.entries(CONTACT_ROLE_LABELS).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
            <input
              type="email"
              placeholder="Email"
              value={contactEmail}
              onChange={(e) => setContactEmail(e.target.value)}
              className="rounded border border-slate-300 px-3 py-2 text-sm"
            />
            <input
              type="tel"
              placeholder="Phone"
              value={contactPhone}
              onChange={(e) => setContactPhone(e.target.value)}
              className="rounded border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={contactIsPrimary}
              onChange={(e) => setContactIsPrimary(e.target.checked)}
            />
            Primary contact for this role
          </label>
        </section>

        <label className="block">
          <span className="text-xs font-medium">Notes</span>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="mt-1 block w-full rounded border border-slate-300 px-3 py-2 text-sm"
            rows={2}
            maxLength={2000}
          />
        </label>

        {error && (
          <div
            className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800"
            data-testid="bp-create-error"
          >
            {error}
          </div>
        )}

        <div className="flex justify-end gap-3">
          <Link
            href={`/business-partners?organization_id=${orgId}`}
            className="rounded border border-slate-300 px-4 py-2 text-sm"
          >
            Cancel
          </Link>
          <button
            type="submit"
            disabled={submitting || !orgId}
            data-testid="bp-create-submit"
            className="rounded bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50"
          >
            {submitting ? 'Creating…' : 'Create partner'}
          </button>
        </div>
      </form>
    </div>
  );
}
