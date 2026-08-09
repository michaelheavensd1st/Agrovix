'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useParams, usePathname, useRouter } from 'next/navigation';
import { ApiError, apiFetch } from '@/lib/api';
import { EmptyState, ForbiddenBanner } from '@/components/ape-ui';
import { SkeletonRows } from '@/components/ui-polish';
import { hasScopedPermission } from '@/lib/permissions';
import { getPurchaseOrder, updatePurchaseOrder, type PurchaseOrder } from '@/lib/purchase-orders';
import type { CurrentUser } from '@/lib/types';
import { PurchaseOrderConflictPanel } from '@/components/purchase-orders/PurchaseOrderConflictPanel';
import {
  PurchaseOrderForm,
  buildUpdatePurchaseOrderBody,
  mapPurchaseOrderFormError,
  type PurchaseOrderFormErrors,
  type PurchaseOrderFormValues,
} from '@/components/purchase-orders/PurchaseOrderForm';

export default function EditPurchaseOrderPage() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useParams<{ purchaseOrderId: string }>();
  const purchaseOrderId = params?.purchaseOrderId ?? '';
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [po, setPo] = useState<PurchaseOrder | null>(null);
  const [identity, setIdentity] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<PurchaseOrderFormErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [conflict, setConflict] = useState<PurchaseOrder | null>(null);
  const [optionsRevision, setOptionsRevision] = useState(0);
  const generationRef = useRef(0);
  const currentIdRef = useRef(purchaseOrderId);
  const mountedRef = useRef(true);
  if (currentIdRef.current !== purchaseOrderId) {
    currentIdRef.current = purchaseOrderId;
    generationRef.current += 1;
  }
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    void apiFetch<CurrentUser>('/v1/auth/me')
      .then((me) => {
        if (!cancelled) setUser(me);
      })
      .catch((caught) => {
        if (!cancelled && caught instanceof ApiError && caught.status === 401)
          router.push(`/login?returnTo=${encodeURIComponent(pathname)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [pathname, router]);
  useEffect(() => {
    if (!purchaseOrderId) return;
    const generation = ++generationRef.current;
    const captured = purchaseOrderId;
    const controller = new AbortController();
    const isCurrent = () =>
      mountedRef.current &&
      generation === generationRef.current &&
      currentIdRef.current === captured;
    setIdentity(captured);
    setPo(null);
    setLoading(true);
    setForbidden(false);
    setNotFound(false);
    setError(null);
    setFieldErrors({});
    setConflict(null);
    void getPurchaseOrder(captured, controller.signal)
      .then((loaded) => {
        if (isCurrent()) setPo(loaded);
      })
      .catch((caught) => {
        if (!isCurrent() || (caught instanceof DOMException && caught.name === 'AbortError'))
          return;
        if (caught instanceof ApiError && caught.status === 401)
          router.push(`/login?returnTo=${encodeURIComponent(pathname)}`);
        else if (caught instanceof ApiError && caught.status === 403) setForbidden(true);
        else if (caught instanceof ApiError && caught.status === 404) setNotFound(true);
        else setError('Unable to load this Purchase Order.');
      })
      .finally(() => {
        if (isCurrent()) setLoading(false);
      });
    return () => controller.abort();
  }, [pathname, purchaseOrderId, router]);
  const current = identity === purchaseOrderId ? po : null;
  async function submit(values: PurchaseOrderFormValues) {
    if (!current || submitting) return;
    const generation = generationRef.current;
    const body = buildUpdatePurchaseOrderBody(current, values);
    if (Object.keys(body).length === 1) return;
    setSubmitting(true);
    setError(null);
    setFieldErrors({});
    try {
      const updated = await updatePurchaseOrder(current.id, body);
      if (generation !== generationRef.current || currentIdRef.current !== current.id) return;
      router.push(`/purchase-orders/${updated.id}`);
    } catch (caught) {
      if (generation !== generationRef.current) return;
      if (caught instanceof ApiError && caught.status === 401)
        router.push(`/login?returnTo=${encodeURIComponent(pathname)}`);
      else if (caught instanceof ApiError && caught.status === 403) setForbidden(true);
      else if (caught instanceof ApiError && caught.status === 404) setNotFound(true);
      else if (isVersionConflict(caught)) {
        try {
          const latest = await getPurchaseOrder(current.id);
          if (generation === generationRef.current) setConflict(latest);
        } catch {
          if (generation === generationRef.current)
            setError(
              'The Draft changed elsewhere, but the latest version could not be loaded. Your edits remain on screen.',
            );
        }
      } else {
        const mapped = mapPurchaseOrderFormError(caught);
        setFieldErrors(mapped.fields);
        setError(mapped.message);
        if (caught instanceof ApiError && caught.status === 409)
          setOptionsRevision((value) => value + 1);
      }
    } finally {
      if (generation === generationRef.current) setSubmitting(false);
    }
  }
  if (identity !== purchaseOrderId || loading) return <Loading />;
  if (forbidden)
    return (
      <main className="mx-auto max-w-6xl p-6">
        <ForbiddenBanner />
      </main>
    );
  if (notFound)
    return (
      <main className="mx-auto max-w-6xl p-6">
        <EmptyState
          title="Purchase order unavailable"
          description="This resource does not exist or is not available to your scope."
        />
      </main>
    );
  if (!current)
    return (
      <main className="mx-auto max-w-6xl p-6">
        <div role="alert">{error || 'Unable to load this Purchase Order.'}</div>
      </main>
    );
  if (!user) return <Loading />;
  const canUpdate = hasScopedPermission(user, 'purchase_order.update', {
    organizationId: current.organization_id,
    ...(current.farm_id ? { farmId: current.farm_id } : {}),
  });
  if (user && !canUpdate)
    return (
      <main className="mx-auto max-w-6xl p-6">
        <ForbiddenBanner />
      </main>
    );
  if (current.status !== 'DRAFT')
    return (
      <main className="mx-auto max-w-6xl p-6">
        <EmptyState
          title="This Purchase Order is not editable"
          description="Only Draft Purchase Orders can be edited."
        />
        <Link href={`/purchase-orders/${current.id}`} className="mt-4 inline-block underline">
          Return to detail
        </Link>
      </main>
    );
  return (
    <main className="mx-auto max-w-6xl space-y-6 px-4 py-8 sm:px-6">
      <header>
        <p className="text-xs uppercase tracking-widest text-muted-foreground">
          Release 6.0.3 · Draft
        </p>
        <h1 className="font-display text-3xl">Edit {current.po_number}</h1>
        <p className="text-sm text-muted-foreground">Version {current.version}</p>
      </header>
      {conflict && (
        <PurchaseOrderConflictPanel
          originalVersion={current.version}
          latest={conflict}
          onReviewLatest={() => router.push(`/purchase-orders/${current.id}`)}
          onDiscard={() => {
            if (conflict.status === 'DRAFT') {
              setPo(conflict);
              setConflict(null);
              setError(null);
              setFieldErrors({});
            } else router.push(`/purchase-orders/${current.id}`);
          }}
        />
      )}
      <PurchaseOrderForm
        key={`edit-${current.id}-${current.version}`}
        mode="edit"
        organizationId={current.organization_id}
        initial={current}
        submitting={submitting || Boolean(conflict && conflict.status !== 'DRAFT')}
        externalErrors={fieldErrors}
        generalError={error}
        optionsRevision={optionsRevision}
        onSubmit={submit}
        onCancel={() => router.push(`/purchase-orders/${current.id}`)}
      />
    </main>
  );
}

function isVersionConflict(caught: unknown): boolean {
  if (!(caught instanceof ApiError) || caught.status !== 409) return false;
  const detail = caught.payload.detail as { code?: string } | undefined;
  return detail?.code === 'purchase_order_version_conflict';
}
function Loading() {
  return (
    <main className="mx-auto max-w-6xl px-4 py-8" data-testid="po-edit-loading" aria-busy="true">
      <SkeletonRows rows={8} />
    </main>
  );
}
