'use client';

import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { ApiError, apiFetch } from '@/lib/api';
import { EmptyState, ForbiddenBanner } from '@/components/ape-ui';
import { SkeletonRows } from '@/components/ui-polish';
import {
  PurchaseOrderForm,
  buildCreatePurchaseOrderBody,
  mapPurchaseOrderFormError,
  type PurchaseOrderFormErrors,
  type PurchaseOrderFormValues,
} from '@/components/purchase-orders/PurchaseOrderForm';
import { createPurchaseOrder } from '@/lib/purchase-orders';
import type { CurrentUser, Organization } from '@/lib/types';

export default function NewPurchaseOrderPage() {
  return (
    <Suspense fallback={<Loading />}>
      <NewPurchaseOrderInner />
    </Suspense>
  );
}

function canCreate(user: CurrentUser | null, organizationId: string): boolean {
  if (!user) return false;
  if (
    user.is_superuser ||
    user.permissions.includes('*') ||
    user.permissions.includes('purchase_order.create')
  )
    return true;
  return (user.permission_scopes ?? []).some(
    (scope) =>
      scope.organization_id === organizationId &&
      (scope.permissions.includes('*') || scope.permissions.includes('purchase_order.create')),
  );
}

function NewPurchaseOrderInner() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const searchKey = searchParams.toString();
  const requestedOrganizationId = searchParams.get('organization_id');
  const [organizations, setOrganizations] = useState<Organization[] | null>(null);
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<PurchaseOrderFormErrors>({});
  const [, setRequestLifecycleVersion] = useState(0);
  const [optionsRevision, setOptionsRevision] = useState(0);
  const activeCreateRequestsRef = useRef(new Map<string, number>());
  const nextCreateRequestTokenRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      apiFetch<CurrentUser>('/v1/auth/me'),
      apiFetch<Organization[]>('/v1/organizations'),
    ])
      .then(([me, orgs]) => {
        if (cancelled) return;
        setUser(me);
        setOrganizations(orgs);
        setLoading(false);
      })
      .catch((caught) => {
        if (cancelled) return;
        if (caught instanceof ApiError && caught.status === 401)
          router.push(`/login?returnTo=${encodeURIComponent(`${pathname}?${searchKey}`)}`);
        else setError('Unable to load your organization context.');
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [pathname, router, searchKey]);
  const organizationId = useMemo(
    () =>
      organizations?.find((org) => org.id === requestedOrganizationId)?.id ??
      organizations?.[0]?.id ??
      '',
    [organizations, requestedOrganizationId],
  );
  const currentOrganizationRef = useRef(organizationId);
  if (currentOrganizationRef.current !== organizationId) {
    currentOrganizationRef.current = organizationId;
  }
  useEffect(() => {
    if (!organizationId || requestedOrganizationId === organizationId) return;
    router.replace(`${pathname}?organization_id=${encodeURIComponent(organizationId)}`);
  }, [organizationId, pathname, requestedOrganizationId, router]);
  async function submit(values: PurchaseOrderFormValues) {
    if (!organizationId || activeCreateRequestsRef.current.has(organizationId)) return;
    const capturedOrganizationId = organizationId;
    const requestToken = ++nextCreateRequestTokenRef.current;
    activeCreateRequestsRef.current.set(capturedOrganizationId, requestToken);
    setRequestLifecycleVersion((version) => version + 1);
    setError(null);
    setFieldErrors({});
    try {
      const created = await createPurchaseOrder(
        capturedOrganizationId,
        buildCreatePurchaseOrderBody(values),
      );
      if (!mountedRef.current || currentOrganizationRef.current !== capturedOrganizationId) return;
      router.push(`/purchase-orders/${created.id}`);
    } catch (caught) {
      if (!mountedRef.current || currentOrganizationRef.current !== capturedOrganizationId) return;
      if (caught instanceof ApiError && caught.status === 401)
        router.push(`/login?returnTo=${encodeURIComponent(`${pathname}?${searchKey}`)}`);
      else if (caught instanceof ApiError && caught.status === 403)
        setError('You do not have permission to create Purchase Orders in this scope.');
      else {
        const mapped = mapPurchaseOrderFormError(caught);
        setFieldErrors(mapped.fields);
        setError(mapped.message);
        if (caught instanceof ApiError && caught.status === 409)
          setOptionsRevision((value) => value + 1);
      }
    } finally {
      if (activeCreateRequestsRef.current.get(capturedOrganizationId) === requestToken)
        activeCreateRequestsRef.current.delete(capturedOrganizationId);
      if (mountedRef.current && currentOrganizationRef.current === capturedOrganizationId)
        setRequestLifecycleVersion((version) => version + 1);
    }
  }
  if (loading || organizations === null) return <Loading />;
  if (error && !organizationId) return <State message={error} />;
  if (!organizationId)
    return (
      <main className="mx-auto max-w-6xl p-6">
        <EmptyState
          title="No organization available"
          description="Join an organization before creating a Purchase Order."
        />
      </main>
    );
  if (!canCreate(user, organizationId))
    return (
      <main className="mx-auto max-w-6xl p-6">
        <ForbiddenBanner />
      </main>
    );
  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <header className="mb-6">
        <p className="text-xs uppercase tracking-widest text-muted-foreground">
          Release 6.0.3 · Draft
        </p>
        <h1 className="font-display text-3xl">Create Purchase Order</h1>
      </header>
      <PurchaseOrderForm
        key={`create-${organizationId}`}
        mode="create"
        organizationId={organizationId}
        submitting={activeCreateRequestsRef.current.has(organizationId)}
        externalErrors={fieldErrors}
        generalError={error}
        optionsRevision={optionsRevision}
        onSubmit={submit}
        onCancel={() =>
          router.push(`/purchase-orders?organization_id=${encodeURIComponent(organizationId)}`)
        }
      />
    </main>
  );
}

function Loading() {
  return (
    <main className="mx-auto max-w-6xl px-4 py-8" data-testid="po-draft-loading" aria-busy="true">
      <SkeletonRows rows={8} />
    </main>
  );
}
function State({ message }: { message: string }) {
  return (
    <main className="mx-auto max-w-6xl p-6">
      <div role="alert">{message}</div>
    </main>
  );
}
