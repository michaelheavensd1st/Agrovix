'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { hasScopedPermission } from '@/lib/permissions';
import type { PurchaseOrder, PurchaseOrderStatus } from '@/lib/purchase-orders';
import type { CurrentUser } from '@/lib/types';

export type PurchaseOrderLifecycleOperation =
  'submit' | 'withdraw' | 'approve' | 'reject' | 'revise' | 'cancel';

export type PurchaseOrderLifecycleActionResult =
  { kind: 'completed' } | { kind: 'reason-error'; message: string } | { kind: 'failed' };

type ActionDefinition = {
  operation: PurchaseOrderLifecycleOperation;
  label: string;
  permission: string;
  statuses: readonly PurchaseOrderStatus[];
  reason: 'none' | 'optional' | 'required';
  destructive?: boolean;
};

const ACTIONS: readonly ActionDefinition[] = [
  {
    operation: 'submit',
    label: 'Submit',
    permission: 'purchase_order.submit',
    statuses: ['DRAFT'],
    reason: 'none',
  },
  {
    operation: 'withdraw',
    label: 'Withdraw',
    permission: 'purchase_order.update',
    statuses: ['SUBMITTED'],
    reason: 'required',
  },
  {
    operation: 'approve',
    label: 'Approve',
    permission: 'purchase_order.approve',
    statuses: ['SUBMITTED'],
    reason: 'optional',
  },
  {
    operation: 'reject',
    label: 'Reject',
    permission: 'purchase_order.reject',
    statuses: ['SUBMITTED'],
    reason: 'required',
    destructive: true,
  },
  {
    operation: 'revise',
    label: 'Return to Draft',
    permission: 'purchase_order.update',
    statuses: ['REJECTED'],
    reason: 'required',
  },
  {
    operation: 'cancel',
    label: 'Cancel Purchase Order',
    permission: 'purchase_order.cancel',
    statuses: ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED'],
    reason: 'required',
    destructive: true,
  },
];

export function PurchaseOrderLifecycleActions({
  purchaseOrder,
  user,
  pendingOperation,
  error,
  onAction,
}: {
  purchaseOrder: PurchaseOrder;
  user: CurrentUser | null;
  pendingOperation: PurchaseOrderLifecycleOperation | null;
  error: string | null;
  onAction: (
    operation: PurchaseOrderLifecycleOperation,
    reason?: string,
  ) => Promise<PurchaseOrderLifecycleActionResult>;
}) {
  const [selected, setSelected] = useState<ActionDefinition | null>(null);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const dialogTitleRef = useRef<HTMLHeadingElement>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const invokingActionRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  const context = useMemo(
    () => ({
      organizationId: purchaseOrder.organization_id,
      ...(purchaseOrder.farm_id ? { farmId: purchaseOrder.farm_id } : {}),
    }),
    [purchaseOrder.farm_id, purchaseOrder.organization_id],
  );
  const creatorCannotApprove = user?.id === purchaseOrder.created_by_id;
  const canApproveByPermission = hasScopedPermission(user, 'purchase_order.approve', context);
  const showSelfApprovalNote =
    purchaseOrder.status === 'SUBMITTED' && creatorCannotApprove && canApproveByPermission;
  const visibleActions = ACTIONS.filter(
    (action) =>
      action.statuses.includes(purchaseOrder.status) &&
      hasScopedPermission(user, action.permission, context) &&
      !(action.operation === 'approve' && creatorCannotApprove),
  );
  const canEdit =
    purchaseOrder.status === 'DRAFT' && hasScopedPermission(user, 'purchase_order.update', context);

  useEffect(() => {
    if (!selected) return;
    if (selected.reason === 'none') dialogTitleRef.current?.focus();
    else reasonRef.current?.focus();
  }, [selected]);

  useEffect(() => {
    if (!selected) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !pendingOperation) closeDialog();
      if (event.key !== 'Tab') return;
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
      if (focusable.length === 0) {
        event.preventDefault();
        dialogTitleRef.current?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialogRef.current?.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !dialogRef.current?.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [pendingOperation, selected]);

  function openDialog(action: ActionDefinition, invokingAction: HTMLButtonElement) {
    invokingActionRef.current = invokingAction;
    setSelected(action);
    setReason('');
    setReasonError(null);
  }

  function closeDialog({ restoreFocus = true }: { restoreFocus?: boolean } = {}) {
    const invokingAction = invokingActionRef.current;
    invokingActionRef.current = null;
    setSelected(null);
    setReason('');
    setReasonError(null);
    if (restoreFocus)
      window.setTimeout(() => {
        if (invokingAction?.isConnected && !invokingAction.disabled) invokingAction.focus();
      }, 0);
  }

  async function confirm() {
    if (!selected || pendingOperation) return;
    const normalizedReason = reason.trim();
    if (selected.reason === 'required' && !normalizedReason) {
      setReasonError(`A reason is required to ${selected.label.toLowerCase()}.`);
      reasonRef.current?.focus();
      return;
    }
    if (normalizedReason.length > 500) {
      setReasonError('Reason must be 500 characters or fewer.');
      reasonRef.current?.focus();
      return;
    }
    setReasonError(null);
    const result = await onAction(
      selected.operation,
      selected.reason === 'none' || !normalizedReason ? undefined : normalizedReason,
    );
    if (result.kind === 'completed') {
      closeDialog({ restoreFocus: false });
    } else if (result.kind === 'reason-error') {
      setReasonError(result.message);
      reasonRef.current?.focus();
    }
  }

  if (!user || (!canEdit && visibleActions.length === 0 && !showSelfApprovalNote)) return null;

  return (
    <section
      className="rounded-xl border border-border bg-card p-5"
      aria-labelledby="po-lifecycle-actions-heading"
      data-testid="po-lifecycle-actions"
    >
      <h2 id="po-lifecycle-actions-heading" className="font-display text-xl">
        Actions
      </h2>
      {error && (
        <div
          className="mt-3 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
          role="alert"
          data-testid="po-lifecycle-error"
        >
          {error}
        </div>
      )}
      {showSelfApprovalNote && (
        <p className="mt-3 text-sm text-muted-foreground" data-testid="po-self-approval-note">
          Independent approval is required. The creator of this Purchase Order cannot approve it.
        </p>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        {canEdit && (
          <Link
            href={`/purchase-orders/${purchaseOrder.id}/edit`}
            className="rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-secondary"
          >
            Edit Draft
          </Link>
        )}
        {visibleActions.map((action) => (
          <button
            key={action.operation}
            type="button"
            onClick={(event) => openDialog(action, event.currentTarget)}
            disabled={pendingOperation !== null}
            data-testid={`po-action-${action.operation}`}
            className={`rounded-md px-3 py-2 text-sm font-medium disabled:opacity-60 ${
              action.destructive
                ? 'border border-destructive text-destructive hover:bg-destructive/10'
                : 'bg-primary text-primary-foreground hover:bg-primary/90'
            }`}
          >
            {pendingOperation === action.operation ? 'Working…' : action.label}
          </button>
        ))}
      </div>

      {selected && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="po-lifecycle-dialog-title"
          aria-describedby="po-lifecycle-dialog-description"
          data-testid="po-lifecycle-dialog"
        >
          <div
            ref={dialogRef}
            className="max-h-[calc(100vh-2rem)] w-full max-w-md overflow-y-auto rounded-2xl border border-border bg-card p-4 shadow-lg sm:p-5"
          >
            <h2
              id="po-lifecycle-dialog-title"
              className="font-display text-lg"
              ref={dialogTitleRef}
              tabIndex={-1}
            >
              Confirm {selected.label.toLowerCase()}
            </h2>
            <p id="po-lifecycle-dialog-description" className="mt-2 text-sm text-muted-foreground">
              This changes the canonical Purchase Order lifecycle state. The server will revalidate
              your permission and whether the action is still allowed.
            </p>
            {selected.reason !== 'none' && (
              <div className="mt-4">
                <label htmlFor="po-lifecycle-reason" className="text-sm font-medium">
                  Reason {selected.reason === 'required' ? '(required)' : '(optional)'}
                </label>
                <textarea
                  id="po-lifecycle-reason"
                  ref={reasonRef}
                  value={reason}
                  onChange={(event) => {
                    setReason(event.target.value);
                    if (reasonError) setReasonError(null);
                  }}
                  maxLength={500}
                  rows={4}
                  disabled={pendingOperation !== null}
                  aria-invalid={reasonError ? true : undefined}
                  aria-describedby={reasonError ? 'po-lifecycle-reason-error' : undefined}
                  className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                />
                {reasonError && (
                  <p
                    id="po-lifecycle-reason-error"
                    className="mt-1 text-sm text-destructive"
                    role="alert"
                  >
                    {reasonError}
                  </p>
                )}
              </div>
            )}
            {error && (
              <p className="mt-3 text-sm text-destructive" role="alert">
                {error}
              </p>
            )}
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={() => closeDialog()}
                disabled={pendingOperation !== null}
                className="rounded-md border border-border px-3 py-2 text-sm disabled:opacity-60"
              >
                Keep current state
              </button>
              <button
                type="button"
                onClick={() => void confirm()}
                disabled={pendingOperation !== null}
                data-testid="po-lifecycle-confirm"
                className={`rounded-md px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60 ${
                  selected.destructive ? 'bg-destructive' : 'bg-primary'
                }`}
              >
                {pendingOperation === selected.operation ? 'Working…' : selected.label}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
