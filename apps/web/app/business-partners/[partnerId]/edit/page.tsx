'use client';

/**
 * Release 6.0.2 — Business Partner edit route.
 *
 * PATCH endpoint updates **partner-header fields only** per Phase 0
 * clarification — capabilities, supplier profile, and contacts have
 * dedicated sub-resource endpoints reachable from the detail page.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useParams } from 'next/navigation';

import { ApiError } from '@/lib/api';
import {
  getBusinessPartner,
  updateBusinessPartner,
  type BusinessPartner,
} from '@/lib/business-partners';

export default function BusinessPartnerEditPage() {
  const router = useRouter();
  const params = useParams<{ partnerId: string }>();
  const partnerId = params?.partnerId ?? '';
  const [partner, setPartner] = useState<BusinessPartner | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  useEffect(() => {
    void (async () => {
      try {
        const p = await getBusinessPartner(partnerId);
        setPartner(p);
        setLegalName(p.legal_name);
        setTradingName(p.trading_name ?? '');
        const a = p.primary_address ?? {};
        setAddressLine1(a.line1 ?? '');
        setAddressLine2(a.line2 ?? '');
        setCity(a.city ?? '');
        setRegion(a.region ?? '');
        setPostalCode(a.postal_code ?? '');
        setAddressCountryCode(a.country_code ?? '');
        setPartnerCountryCode(p.country_code ?? '');
        setEmail(p.email ?? '');
        setPhone(p.phone ?? '');
        setTaxIdentifier(p.tax_identifier ?? '');
        setNotes(p.notes ?? '');
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) setError('Not found.');
        else if (err instanceof ApiError && err.status === 403) setError('Forbidden.');
        else setError('Failed to load partner.');
      } finally {
        setLoading(false);
      }
    })();
  }, [partnerId]);

  async function onSubmit(evt: React.FormEvent) {
    evt.preventDefault();
    if (!partner) return;
    setSaving(true);
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
      await updateBusinessPartner(partner.id, {
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
        setError('Failed to save.');
      }
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="px-6 py-8 text-slate-500">Loading…</div>;
  if (!partner) {
    return (
      <div className="px-6 py-8">
        <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800" data-testid="bp-edit-error">
          {error ?? 'Partner not found.'}
        </div>
      </div>
    );
  }

  return (
    <div className="px-6 py-8 max-w-3xl mx-auto">
      <div className="mb-4">
        <Link href={`/business-partners/${partner.id}`} className="text-sm text-slate-500 hover:underline">
          ← Back to partner
        </Link>
      </div>
      <h1 className="text-2xl font-semibold mb-6">Edit Business Partner</h1>
      <form onSubmit={onSubmit} data-testid="bp-edit-form" className="space-y-4">
        <div className="rounded border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
          Code <span className="font-mono">{partner.code}</span> is immutable.
        </div>
        <label className="block">
          <span className="text-xs font-medium">Legal name</span>
          <input
            type="text"
            required
            data-testid="bp-edit-legal-name"
            value={legalName}
            onChange={(e) => setLegalName(e.target.value)}
            className="mt-1 block w-full rounded border border-slate-300 px-3 py-2 text-sm"
          />
        </label>
        <label className="block">
          <span className="text-xs font-medium">Trading name</span>
          <input
            type="text"
            value={tradingName}
            onChange={(e) => setTradingName(e.target.value)}
            className="mt-1 block w-full rounded border border-slate-300 px-3 py-2 text-sm"
          />
        </label>
        <label className="block">
          <span className="text-xs font-medium">Address line 1</span>
          <input
            type="text"
            value={addressLine1}
            onChange={(e) => setAddressLine1(e.target.value)}
            className="mt-1 block w-full rounded border border-slate-300 px-3 py-2 text-sm"
          />
        </label>
        <label className="block">
          <span className="text-xs font-medium">Address line 2</span>
          <input
            type="text"
            value={addressLine2}
            onChange={(e) => setAddressLine2(e.target.value)}
            className="mt-1 block w-full rounded border border-slate-300 px-3 py-2 text-sm"
          />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-xs font-medium">City</span>
            <input
              type="text"
              value={city}
              onChange={(e) => setCity(e.target.value)}
              className="mt-1 block w-full rounded border border-slate-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium">Region</span>
            <input
              type="text"
              value={region}
              onChange={(e) => setRegion(e.target.value)}
              className="mt-1 block w-full rounded border border-slate-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium">Postal code</span>
            <input
              type="text"
              value={postalCode}
              onChange={(e) => setPostalCode(e.target.value)}
              className="mt-1 block w-full rounded border border-slate-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium">Country (ISO α-2)</span>
            <input
              type="text"
              maxLength={2}
              value={addressCountryCode}
              onChange={(e) => setAddressCountryCode(e.target.value.toUpperCase())}
              data-testid="bp-edit-addr-country-code"
              className="mt-1 block w-full rounded border border-slate-300 px-3 py-2 font-mono text-sm uppercase"
            />
          </label>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-xs font-medium">Email</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              data-testid="bp-edit-email"
              className="mt-1 block w-full rounded border border-slate-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium">Phone</span>
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              data-testid="bp-edit-phone"
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
              data-testid="bp-edit-country-code"
              className="mt-1 block w-full rounded border border-slate-300 px-3 py-2 font-mono text-sm uppercase"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium">Tax identifier</span>
            <input
              type="text"
              value={taxIdentifier}
              onChange={(e) => setTaxIdentifier(e.target.value)}
              data-testid="bp-edit-tax-identifier"
              className="mt-1 block w-full rounded border border-slate-300 px-3 py-2 text-sm"
            />
          </label>
        </div>
        <label className="block">
          <span className="text-xs font-medium">Notes</span>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="mt-1 block w-full rounded border border-slate-300 px-3 py-2 text-sm"
            rows={4}
            maxLength={2000}
          />
        </label>
        {error && (
          <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800" data-testid="bp-edit-error">
            {error}
          </div>
        )}
        <div className="flex justify-end gap-3">
          <Link href={`/business-partners/${partner.id}`} className="rounded border border-slate-300 px-4 py-2 text-sm">
            Cancel
          </Link>
          <button
            type="submit"
            disabled={saving}
            data-testid="bp-edit-submit"
            className="rounded bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </form>
    </div>
  );
}
