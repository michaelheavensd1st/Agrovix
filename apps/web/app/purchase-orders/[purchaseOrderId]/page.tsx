'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, usePathname, useRouter } from 'next/navigation';
import { ApiError, apiFetch } from '@/lib/api';
import { EmptyState, ErrorBanner, ForbiddenBanner } from '@/components/ape-ui';
import { SkeletonRows } from '@/components/ui-polish';
import { PurchaseOrderDetail } from '@/components/purchase-orders/PurchaseOrderDetail';
import { PurchaseOrderTransitionHistory } from '@/components/purchase-orders/PurchaseOrderTransitionHistory';
import {
  getPurchaseOrder,
  listPurchaseOrderTransitions,
  type PurchaseOrder,
  type PurchaseOrderTransition,
} from '@/lib/purchase-orders';
import type { CurrentUser } from '@/lib/types';

export default function PurchaseOrderDetailPage() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useParams<{ purchaseOrderId: string }>();
  const purchaseOrderId = params?.purchaseOrderId ?? '';
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [purchaseOrder, setPurchaseOrder] = useState<PurchaseOrder | null>(null);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailIdentity, setDetailIdentity] = useState(purchaseOrderId);
  const [transitions, setTransitions] = useState<PurchaseOrderTransition[]>([]);
  const [transitionCursor, setTransitionCursor] = useState<string | undefined>();
  const [nextTransitionCursor, setNextTransitionCursor] = useState<string | null>(null);
  const [previousTransitionCursors, setPreviousTransitionCursors] = useState<string[]>([]);
  const [transitionsLoading, setTransitionsLoading] = useState(false);
  const [transitionsError, setTransitionsError] = useState<string | null>(null);
  const [transitionIdentity, setTransitionIdentity] = useState<string | null>(null);
  const detailGenerationRef = useRef(0);
  const transitionGenerationRef = useRef(0);
  const currentIdRef = useRef(purchaseOrderId);
  const mountedRef = useRef(true);
  const returnToRef = useRef(pathname);

  if (currentIdRef.current !== purchaseOrderId) {
    currentIdRef.current = purchaseOrderId;
    detailGenerationRef.current += 1;
    transitionGenerationRef.current += 1;
  }

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      detailGenerationRef.current += 1;
      transitionGenerationRef.current += 1;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void apiFetch<CurrentUser>('/v1/auth/me')
      .then((me) => {
        if (!cancelled) setUser(me);
      })
      .catch((caught) => {
        if (!cancelled && caught instanceof ApiError && caught.status === 401) {
          router.push(`/login?returnTo=${encodeURIComponent(returnToRef.current)}`);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [router]);

  useEffect(() => {
    if (!purchaseOrderId) return;
    const generation = ++detailGenerationRef.current;
    const capturedId = purchaseOrderId;
    const controller = new AbortController();
    const isCurrent = () =>
      mountedRef.current &&
      generation === detailGenerationRef.current &&
      capturedId === currentIdRef.current;
    setDetailIdentity(capturedId);
    setPurchaseOrder(null);
    setLoading(true);
    setForbidden(false);
    setNotFound(false);
    setError(null);
    setTransitions([]);
    setTransitionCursor(undefined);
    setNextTransitionCursor(null);
    setPreviousTransitionCursors([]);
    setTransitionsError(null);
    setTransitionIdentity(null);
    void getPurchaseOrder(capturedId, controller.signal)
      .then((po) => {
        if (!isCurrent()) return;
        setPurchaseOrder(po);
        setForbidden(false);
        setNotFound(false);
        setError(null);
      })
      .catch((caught) => {
        if (!isCurrent() || (caught instanceof DOMException && caught.name === 'AbortError'))
          return;
        if (caught instanceof ApiError && caught.status === 401) {
          router.push(`/login?returnTo=${encodeURIComponent(returnToRef.current)}`);
        } else if (caught instanceof ApiError && caught.status === 403) {
          setForbidden(true);
        } else if (caught instanceof ApiError && caught.status === 404) {
          setNotFound(true);
        } else {
          setError('Unable to load this purchase order. Try again.');
        }
      })
      .finally(() => {
        if (isCurrent()) setLoading(false);
      });
    return () => controller.abort();
  }, [purchaseOrderId, router]);

  const loadTransitions = useCallback(() => {
    if (!purchaseOrder) return () => undefined;
    const generation = ++transitionGenerationRef.current;
    const capturedId = purchaseOrder.id;
    const capturedIdentity = `${capturedId}\u0000${transitionCursor ?? ''}`;
    const controller = new AbortController();
    const isCurrent = () =>
      mountedRef.current &&
      generation === transitionGenerationRef.current &&
      capturedId === currentIdRef.current;
    setTransitionsLoading(true);
    setTransitionsError(null);
    setTransitions([]);
    setNextTransitionCursor(null);
    setTransitionIdentity(capturedIdentity);
    void listPurchaseOrderTransitions(capturedId, {
      cursor: transitionCursor,
      limit: 50,
      signal: controller.signal,
    })
      .then((page) => {
        if (!isCurrent()) return;
        setTransitions(page.items);
        setNextTransitionCursor(page.next_cursor);
      })
      .catch((caught) => {
        if (!isCurrent() || (caught instanceof DOMException && caught.name === 'AbortError'))
          return;
        if (caught instanceof ApiError && caught.status === 401) {
          router.push(`/login?returnTo=${encodeURIComponent(returnToRef.current)}`);
        } else if (caught instanceof ApiError && caught.status === 403) {
          setTransitionsError('You do not have permission to view transition history.');
        } else if (caught instanceof ApiError && caught.status === 404) {
          setTransitionsError('Transition history is unavailable.');
        } else {
          setTransitionsError('Unable to load transition history.');
        }
      })
      .finally(() => {
        if (isCurrent()) setTransitionsLoading(false);
      });
    return () => controller.abort();
  }, [purchaseOrder, router, transitionCursor]);

  useEffect(() => loadTransitions(), [loadTransitions]);

  const detailIsCurrent = detailIdentity === purchaseOrderId;
  const visiblePurchaseOrder = detailIsCurrent ? purchaseOrder : null;
  const currentTransitionIdentity = visiblePurchaseOrder
    ? `${visiblePurchaseOrder.id}\u0000${transitionCursor ?? ''}`
    : null;
  const transitionsAreCurrent = transitionIdentity === currentTransitionIdentity;
  const visibleTransitions = transitionsAreCurrent ? transitions : [];
  const visibleTransitionsLoading =
    visiblePurchaseOrder !== null && (transitionsLoading || !transitionsAreCurrent);
  const visibleTransitionsError = transitionsAreCurrent ? transitionsError : null;
  const visibleNextTransitionCursor = transitionsAreCurrent ? nextTransitionCursor : null;

  function nextTransitions() {
    if (!nextTransitionCursor) return;
    setPreviousTransitionCursors((existing) => [...existing, transitionCursor || '']);
    setTransitionCursor(nextTransitionCursor);
  }

  function previousTransitions() {
    if (previousTransitionCursors.length === 0) return;
    const previous = previousTransitionCursors[previousTransitionCursors.length - 1];
    setPreviousTransitionCursors((existing) => existing.slice(0, -1));
    setTransitionCursor(previous || undefined);
  }

  if (!detailIsCurrent || (loading && !visiblePurchaseOrder)) {
    return (
      <main
        className="mx-auto max-w-6xl px-4 py-8 sm:px-6"
        data-testid="po-detail-loading"
        aria-busy="true"
      >
        <SkeletonRows rows={8} />
      </main>
    );
  }
  if (detailIsCurrent && forbidden)
    return (
      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        <ForbiddenBanner />
      </main>
    );
  if (detailIsCurrent && notFound)
    return (
      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        <EmptyState
          title="Purchase order unavailable"
          description="This resource does not exist or is not available to your scope."
        />
      </main>
    );
  if (detailIsCurrent && error)
    return (
      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        <div role="alert">
          <ErrorBanner message={error} />
        </div>
      </main>
    );
  if (!visiblePurchaseOrder) return null;

  return (
    <main className="mx-auto max-w-6xl space-y-6 px-4 py-8 sm:px-6">
      <PurchaseOrderDetail purchaseOrder={visiblePurchaseOrder} currentUserId={user?.id ?? null} />
      <PurchaseOrderTransitionHistory
        transitions={visibleTransitions}
        currentUserId={user?.id ?? null}
        loading={visibleTransitionsLoading}
        error={visibleTransitionsError}
        nextCursor={visibleNextTransitionCursor}
        canGoBack={previousTransitionCursors.length > 0}
        onNext={nextTransitions}
        onPrevious={previousTransitions}
      />
    </main>
  );
}
