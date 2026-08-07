/**
 * Release 6.0.2 — Business Partner web-client types + helpers.
 *
 * Every shape mirrors the FastAPI response schemas in
 * ``apps/api/app/schemas/business_partner.py``. Cursor pagination
 * follows the frozen §11.1 contract — opaque token echoed back.
 */

import { apiFetch, apiFetchResult } from '@/lib/api';

export type UUID = string;

export type BusinessPartnerCapabilityCode =
  | 'supplier'
  | 'customer'
  | 'transporter'
  | 'contractor'
  | 'veterinary_service'
  | 'laboratory'
  | 'consultant'
  | 'other';

export const CAPABILITY_LABELS: Record<BusinessPartnerCapabilityCode, string> = {
  supplier: 'Supplier',
  customer: 'Customer',
  transporter: 'Transporter',
  contractor: 'Contractor',
  veterinary_service: 'Veterinary service',
  laboratory: 'Laboratory',
  consultant: 'Consultant',
  other: 'Other',
};

export type QualificationStatus = 'unqualified' | 'approved' | 'blocked';
export const QUALIFICATION_LABELS: Record<QualificationStatus, string> = {
  unqualified: 'Unqualified',
  approved: 'Approved',
  blocked: 'Blocked',
};

export type PreferenceTier = 'standard' | 'preferred';
export const PREFERENCE_LABELS: Record<PreferenceTier, string> = {
  standard: 'Standard',
  preferred: 'Preferred',
};

export type ContactRole =
  'accounts' | 'warehouse' | 'sales' | 'driver' | 'managing_director' | 'technical' | 'other';
export const CONTACT_ROLE_LABELS: Record<ContactRole, string> = {
  accounts: 'Accounts',
  warehouse: 'Warehouse',
  sales: 'Sales',
  driver: 'Driver',
  managing_director: 'Managing director',
  technical: 'Technical',
  other: 'Other',
};

export interface BusinessPartnerCapability {
  id: UUID;
  business_partner_id: UUID;
  capability: BusinessPartnerCapabilityCode;
  created_at: string;
}

export interface BusinessPartnerSupplierProfile {
  id: UUID;
  business_partner_id: UUID;
  qualification_status: QualificationStatus;
  qualification_note: string | null;
  qualified_by_id: UUID | null;
  qualified_at: string | null;
  preference_tier: PreferenceTier;
  created_at: string;
  updated_at: string;
}

export interface BusinessPartnerContact {
  id: UUID;
  business_partner_id: UUID;
  name: string;
  job_title: string | null;
  email: string | null;
  phone: string | null;
  contact_role: ContactRole;
  is_primary: boolean;
  is_active: boolean;
  notes: string | null;
  deactivated_at: string | null;
  deactivation_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface PartnerAddress {
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  region?: string | null;
  postal_code?: string | null;
  country_code?: string | null;
}

export interface BusinessPartner {
  id: UUID;
  organization_id: UUID;
  code: string;
  legal_name: string;
  trading_name: string | null;
  primary_address: PartnerAddress | null;
  email: string | null;
  phone: string | null;
  country_code: string | null;
  tax_identifier: string | null;
  notes: string | null;
  metadata: Record<string, unknown> | null;
  is_active: boolean;
  deactivated_at: string | null;
  deactivation_reason: string | null;
  created_at: string;
  updated_at: string;
  capabilities: BusinessPartnerCapability[];
  supplier_profile: BusinessPartnerSupplierProfile | null;
  contacts: BusinessPartnerContact[];
}

export interface CursorPage<T> {
  items: T[];
  next_cursor: string | null;
}

// --------------------------------------------------------------------- //
// API client (thin wrapper over apiFetch).
// --------------------------------------------------------------------- //
export interface ListPartnersParams {
  organizationId: UUID;
  capability?: BusinessPartnerCapabilityCode;
  active?: boolean;
  qualification?: QualificationStatus;
  preference?: PreferenceTier;
  search?: string;
  cursor?: string;
  limit?: number;
}

export async function listBusinessPartners(
  params: ListPartnersParams,
): Promise<CursorPage<BusinessPartner>> {
  const q = new URLSearchParams();
  if (params.capability) q.set('capability', params.capability);
  if (params.active !== undefined) q.set('active', String(params.active));
  if (params.qualification) q.set('qualification', params.qualification);
  if (params.preference) q.set('preference', params.preference);
  if (params.search) q.set('search', params.search);
  if (params.cursor) q.set('cursor', params.cursor);
  if (params.limit) q.set('limit', String(params.limit));
  const suffix = q.toString();
  return apiFetch<CursorPage<BusinessPartner>>(
    `/v1/organizations/${params.organizationId}/business-partners${suffix ? `?${suffix}` : ''}`,
  );
}

export interface CreatePartnerBody {
  code: string;
  legal_name: string;
  trading_name?: string | null;
  primary_address?: PartnerAddress | null;
  email?: string | null;
  phone?: string | null;
  country_code?: string | null;
  tax_identifier?: string | null;
  notes?: string | null;
  metadata?: Record<string, unknown> | null;
  capabilities: BusinessPartnerCapabilityCode[];
  supplier_profile?: {
    qualification_status: QualificationStatus;
    qualification_note?: string | null;
    preference_tier: PreferenceTier;
  } | null;
  contacts?: Array<{
    name: string;
    job_title?: string | null;
    email?: string | null;
    phone?: string | null;
    contact_role: ContactRole;
    is_primary?: boolean;
    notes?: string | null;
  }>;
}

export async function createBusinessPartner(
  organizationId: UUID,
  body: CreatePartnerBody,
): Promise<BusinessPartner> {
  return apiFetch<BusinessPartner>(`/v1/organizations/${organizationId}/business-partners`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function getBusinessPartner(id: UUID): Promise<BusinessPartner> {
  return apiFetch<BusinessPartner>(`/v1/business-partners/${id}`);
}

export interface UpdatePartnerHeaderBody {
  legal_name?: string;
  trading_name?: string | null;
  primary_address?: PartnerAddress | null;
  email?: string | null;
  phone?: string | null;
  country_code?: string | null;
  tax_identifier?: string | null;
  notes?: string | null;
  metadata?: Record<string, unknown> | null;
}

export async function updateBusinessPartner(
  id: UUID,
  body: UpdatePartnerHeaderBody,
): Promise<BusinessPartner> {
  return apiFetch<BusinessPartner>(`/v1/business-partners/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export async function deactivateBusinessPartner(
  id: UUID,
  reason: string,
): Promise<BusinessPartner> {
  return apiFetch<BusinessPartner>(`/v1/business-partners/${id}/deactivate`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

export async function restoreBusinessPartner(id: UUID, reason: string): Promise<BusinessPartner> {
  return apiFetch<BusinessPartner>(`/v1/business-partners/${id}/restore`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

export async function addCapability(
  partnerId: UUID,
  capability: BusinessPartnerCapabilityCode,
): Promise<BusinessPartnerCapability> {
  return apiFetch<BusinessPartnerCapability>(`/v1/business-partners/${partnerId}/capabilities`, {
    method: 'POST',
    body: JSON.stringify({ capability }),
  });
}

export async function removeCapability(
  partnerId: UUID,
  capability: BusinessPartnerCapabilityCode,
): Promise<void> {
  const result = await apiFetchResult<null>(
    `/v1/business-partners/${partnerId}/capabilities/${capability}`,
    { method: 'DELETE' },
  );
  void result;
}

export async function putSupplierProfile(
  partnerId: UUID,
  body: {
    qualification_status: QualificationStatus;
    qualification_note?: string | null;
    preference_tier: PreferenceTier;
  },
): Promise<BusinessPartnerSupplierProfile> {
  return apiFetch<BusinessPartnerSupplierProfile>(
    `/v1/business-partners/${partnerId}/supplier-profile`,
    { method: 'PUT', body: JSON.stringify(body) },
  );
}

export interface CreateContactBody {
  name: string;
  job_title?: string | null;
  email?: string | null;
  phone?: string | null;
  contact_role: ContactRole;
  is_primary?: boolean;
  notes?: string | null;
}

export async function createContact(
  partnerId: UUID,
  body: CreateContactBody,
): Promise<BusinessPartnerContact> {
  return apiFetch<BusinessPartnerContact>(`/v1/business-partners/${partnerId}/contacts`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function updateContact(
  contactId: UUID,
  body: Partial<CreateContactBody>,
): Promise<BusinessPartnerContact> {
  return apiFetch<BusinessPartnerContact>(`/v1/business-partner-contacts/${contactId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export async function deactivateContact(
  contactId: UUID,
  reason: string,
): Promise<BusinessPartnerContact> {
  return apiFetch<BusinessPartnerContact>(`/v1/business-partner-contacts/${contactId}/deactivate`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

export async function restoreContact(
  contactId: UUID,
  reason: string,
): Promise<BusinessPartnerContact> {
  return apiFetch<BusinessPartnerContact>(`/v1/business-partner-contacts/${contactId}/restore`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}
