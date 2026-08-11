'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from '@/lib/api';
import {
  canonicalPurchaseOrderDecimal,
  comparePurchaseOrderDecimals,
  formatPurchaseOrderDecimal,
  isPositivePurchaseOrderDecimal,
  subtractPurchaseOrderDecimals,
} from '@/lib/purchase-order-decimals';
import {
  createPurchaseReceipt,
  listReceiptStorageLocations,
  listReceiptWarehouses,
  type PurchaseReceiptInput,
  type StorageLocationOption,
  type WarehouseOption,
} from '@/lib/purchase-receipts';
import type { PurchaseOrder } from '@/lib/purchase-orders';
import { ErrorBanner } from '@/components/ape-ui';
import { usePathname, useRouter } from 'next/navigation';

type LineValue = { included: boolean; quantity: string; lotCode: string; storageLocationId: string; expiryDate: string };
type Attempt = { key: string; payload: PurchaseReceiptInput; uncertain: boolean };
export type ReceiptAuthoritativeFailure =
  | 'purchase-order-changed'
  | 'warehouse-changed'
  | 'authorization-changed';

const ERROR_MESSAGES: Record<string, string> = {
  invalid_quantity: 'Enter a positive quantity with no more than six decimal places.',
  canonical_quantity_not_representable: 'This quantity cannot be represented exactly in the item’s canonical unit.',
  purchase_order_over_receipt: 'The receipt exceeds the remaining Purchase Order quantity. Refresh and review the line.',
  warehouse_unavailable: 'The selected warehouse is no longer available.',
  warehouse_farm_scope_mismatch: 'The selected warehouse does not match this Purchase Order’s farm.',
  purchase_order_not_receivable: 'This Purchase Order is no longer receivable.',
  ordered_unit_mismatch: 'The Purchase Order unit no longer matches the inventory item.',
  lot_attribute_conflict: 'An existing lot with this code has different location or expiry details.',
  lot_creation_conflict: 'The lot could not be created safely. Try the same receipt again.',
  invalid_received_at: 'Enter a valid received date and time.',
  not_authorized: 'You no longer have permission to receive this Purchase Order.',
};

function nullable(value: string): string | null { return value.trim() || null; }

export function PurchaseReceiptForm({ purchaseOrder, open, onClose, onCompleted, onAuthoritativeFailure }: {
  purchaseOrder: PurchaseOrder;
  open: boolean;
  onClose: () => void;
  onCompleted: (replayed: boolean) => void;
  onAuthoritativeFailure: (failure: ReceiptAuthoritativeFailure) => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const initialLines = useMemo(() => Object.fromEntries(purchaseOrder.lines.map((line) => [line.id, { included: false, quantity: '', lotCode: '', storageLocationId: '', expiryDate: '' } satisfies LineValue])), [purchaseOrder.lines]);
  const [warehouseId, setWarehouseId] = useState('');
  const [supplierReference, setSupplierReference] = useState('');
  const [receivedAt, setReceivedAt] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<Record<string, LineValue>>(initialLines);
  const [warehouses, setWarehouses] = useState<WarehouseOption[]>([]);
  const [locations, setLocations] = useState<StorageLocationOption[]>([]);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [generalError, setGeneralError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const mountedRef = useRef(true);
  const submitLockRef = useRef(false);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const currentPurchaseOrderIdRef = useRef(purchaseOrder.id);
  const currentContextRef = useRef('');
  const currentWarehouseIdRef = useRef('');
  const warehouseGenerationRef = useRef(0);
  const locationGenerationRef = useRef(0);
  const wasOpenRef = useRef(false);
  currentPurchaseOrderIdRef.current = purchaseOrder.id;
  const renderedContext = `${purchaseOrder.id}\u0000${purchaseOrder.organization_id}\u0000${purchaseOrder.farm_id ?? ''}`;
  if (currentContextRef.current !== renderedContext) {
    currentContextRef.current = renderedContext;
    currentWarehouseIdRef.current = '';
    locationGenerationRef.current += 1;
  }

  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      currentWarehouseIdRef.current = '';
      locationGenerationRef.current += 1;
      setWarehouseId(''); setSupplierReference(''); setReceivedAt(''); setNotes('');
      setLines(initialLines); setErrors({}); setGeneralError(null); setAttempt(null);
    } else if (!open && wasOpenRef.current) {
      currentWarehouseIdRef.current = '';
      locationGenerationRef.current += 1;
      setLocations([]); setLocationError(null);
    }
    wasOpenRef.current = open;
  }, [initialLines, open]);
  useEffect(() => { if (open) titleRef.current?.focus(); }, [open]);
  useEffect(() => {
    if (!open) return;
    const generation = ++warehouseGenerationRef.current;
    const capturedContext = currentContextRef.current;
    const controller = new AbortController();
    setWarehouses([]);
    setOptionsError(null);
    void listReceiptWarehouses(purchaseOrder.organization_id, controller.signal)
      .then((items) => {
        if (!mountedRef.current || generation !== warehouseGenerationRef.current || capturedContext !== currentContextRef.current) return;
        setWarehouses(items.filter((warehouse) => warehouse.status !== 'closed' && (purchaseOrder.farm_id ? warehouse.farm_id === null || warehouse.farm_id === purchaseOrder.farm_id : warehouse.farm_id === null)));
      })
      .catch((caught) => {
        if (!mountedRef.current || generation !== warehouseGenerationRef.current || capturedContext !== currentContextRef.current || (caught instanceof DOMException && caught.name === 'AbortError')) return;
        setOptionsError(caught instanceof ApiError && caught.status === 403 ? 'Warehouse choices are unavailable with your current permissions.' : 'Unable to load warehouses.');
      });
    return () => controller.abort();
  }, [open, purchaseOrder.farm_id, purchaseOrder.organization_id]);

  useEffect(() => {
    setLocations([]); setLocationError(null);
    if (!open || !warehouseId || currentWarehouseIdRef.current !== warehouseId) return;
    const generation = ++locationGenerationRef.current;
    const capturedWarehouseId = warehouseId;
    const capturedContext = currentContextRef.current;
    const controller = new AbortController();
    void listReceiptStorageLocations(warehouseId, controller.signal)
      .then((items) => {
        if (!mountedRef.current || generation !== locationGenerationRef.current || capturedWarehouseId !== currentWarehouseIdRef.current || capturedContext !== currentContextRef.current) return;
        setLocations(items.filter((item) => !item.deleted_at));
      })
      .catch((caught) => {
        if (!mountedRef.current || generation !== locationGenerationRef.current || capturedWarehouseId !== currentWarehouseIdRef.current || capturedContext !== currentContextRef.current || (caught instanceof DOMException && caught.name === 'AbortError')) return;
        setLocationError(caught instanceof ApiError && caught.status === 403 ? 'Storage locations are unavailable with your current permissions.' : 'Unable to load storage locations.');
      });
    return () => controller.abort();
  }, [open, warehouseId]);

  useEffect(() => {
    if (!open) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy && !attempt?.uncertain) onClose();
      if (event.key !== 'Tab') return;
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? []);
      if (!focusable.length) { event.preventDefault(); titleRef.current?.focus(); return; }
      const first = focusable[0]; const last = focusable[focusable.length - 1];
      if (!dialogRef.current?.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
      else if (event.shiftKey && (document.activeElement === first || document.activeElement === titleRef.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', keydown); return () => window.removeEventListener('keydown', keydown);
  }, [attempt?.uncertain, busy, onClose, open]);

  function updateLine(id: string, patch: Partial<LineValue>) { setLines((current) => ({ ...current, [id]: { ...current[id], ...patch } })); }

  function changeWarehouse(nextWarehouseId: string) {
    locationGenerationRef.current += 1;
    currentWarehouseIdRef.current = nextWarehouseId;
    setWarehouseId(nextWarehouseId);
    setLocations([]);
    setLocationError(null);
    setLines((current) => Object.fromEntries(Object.entries(current).map(([id, value]) => [id, { ...value, storageLocationId: '' }])));
  }

  function buildPayload(): PurchaseReceiptInput | null {
    const nextErrors: Record<string, string> = {};
    if (!warehouseId) nextErrors.warehouse = 'Select a warehouse.';
    if (supplierReference.trim().length > 120) nextErrors.supplierReference = 'Use 120 characters or fewer.';
    if (notes.trim().length > 4000) nextErrors.notes = 'Use 4000 characters or fewer.';
    const selected = purchaseOrder.lines.filter((line) => lines[line.id]?.included);
    if (!selected.length) nextErrors.lines = 'Select at least one Purchase Order line.';
    const payloadLines = selected.flatMap((line) => {
      const value = lines[line.id];
      const remaining = subtractPurchaseOrderDecimals(line.ordered_quantity, line.received_quantity);
      if (!isPositivePurchaseOrderDecimal(value.quantity) || value.quantity.replace('.', '').length > 18) nextErrors[`${line.id}.quantity`] = 'Enter a positive quantity with at most 18 digits and six decimal places.';
      else if (comparePurchaseOrderDecimals(value.quantity, remaining) > 0) nextErrors[`${line.id}.quantity`] = 'Quantity is above the currently remaining amount.';
      if (!value.lotCode.trim()) nextErrors[`${line.id}.lot`] = 'Enter a lot code.';
      else if (value.lotCode.trim().length > 128) nextErrors[`${line.id}.lot`] = 'Use 128 characters or fewer.';
      if (nextErrors[`${line.id}.quantity`] || nextErrors[`${line.id}.lot`]) return [];
      return [{ purchase_order_line_id: line.id, lot_code: value.lotCode.trim(), quantity: canonicalPurchaseOrderDecimal(value.quantity), ...(value.storageLocationId ? { storage_location_id: value.storageLocationId } : {}), ...(value.expiryDate ? { expiry_date: value.expiryDate } : {}) }];
    });
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) return null;
    let receivedIso: string | null = null;
    if (receivedAt) {
      const date = new Date(receivedAt);
      if (Number.isNaN(date.getTime())) { setErrors({ receivedAt: 'Enter a valid date and time.' }); return null; }
      receivedIso = date.toISOString();
    }
    return { warehouse_id: warehouseId, supplier_delivery_reference: nullable(supplierReference), received_at: receivedIso, notes: nullable(notes), lines: payloadLines };
  }

  async function send(current: Attempt) {
    setBusy(true); setGeneralError(null);
    const capturedPurchaseOrderId = purchaseOrder.id;
    try {
      const result = await createPurchaseReceipt(purchaseOrder.id, current.payload, current.key);
      if (!mountedRef.current || currentPurchaseOrderIdRef.current !== capturedPurchaseOrderId) return;
      setAttempt(null); onCompleted(result.replayed);
    } catch (caught) {
      if (!mountedRef.current || currentPurchaseOrderIdRef.current !== capturedPurchaseOrderId) return;
      if (!(caught instanceof ApiError)) {
        setAttempt({ ...current, uncertain: true });
        setGeneralError('The result is uncertain. Retry the exact same receipt or explicitly abandon this attempt.');
      } else {
        const detail = caught.payload.detail;
        const code = detail && typeof detail === 'object' && !Array.isArray(detail) ? (detail as { code?: unknown }).code : undefined;
        if (caught.status === 401) {
          setAttempt(null);
          onAuthoritativeFailure('authorization-changed');
          router.push(`/login?returnTo=${encodeURIComponent(pathname)}`);
        } else if (code === 'idempotency_key_payload_conflict') {
          setAttempt(null);
          setGeneralError('This submission could not be replayed because its saved data differs. Review the form before starting a new submission.');
        } else {
          setAttempt(null);
          if (code === 'purchase_order_over_receipt' || code === 'purchase_order_not_receivable') onAuthoritativeFailure('purchase-order-changed');
          if (code === 'warehouse_unavailable' || code === 'warehouse_farm_scope_mismatch') {
            changeWarehouse('');
            warehouseGenerationRef.current += 1;
            onAuthoritativeFailure('warehouse-changed');
          }
          if (code === 'not_authorized' || caught.status === 403) onAuthoritativeFailure('authorization-changed');
          if (code === 'invalid_quantity') {
            const quantityErrors = Object.fromEntries(purchaseOrder.lines.filter((line) => lines[line.id]?.included).map((line) => [`${line.id}.quantity`, ERROR_MESSAGES.invalid_quantity]));
            setErrors(quantityErrors);
          } else if (Array.isArray(detail)) {
            const mapped: Record<string, string> = {};
            for (const entry of detail) {
              if (!entry || typeof entry !== 'object') continue;
              const loc = (entry as { loc?: unknown }).loc;
              if (!Array.isArray(loc)) continue;
              const lineIndex = loc[0] === 'body' && loc[1] === 'lines' && typeof loc[2] === 'number' ? loc[2] : null;
              const field = loc[3];
              const selected = purchaseOrder.lines.filter((line) => lines[line.id]?.included);
              const poLine = lineIndex === null ? null : selected[lineIndex];
              if (poLine && field === 'quantity') mapped[`${poLine.id}.quantity`] = 'Review this receipt quantity.';
              if (poLine && field === 'lot_code') mapped[`${poLine.id}.lot`] = 'Review this lot code.';
            }
            setErrors(mapped);
          }
          const message = code === 'idempotency_key_required'
            ? 'The receipt could not be safely identified. Review it and start a new submission.'
            : typeof code === 'string' ? (ERROR_MESSAGES[code] ?? 'Unable to post this receipt. Review the form and try again.') : 'Unable to post this receipt. Review the form and try again.';
          setGeneralError(message);
        }
      }
    } finally { submitLockRef.current = false; if (mountedRef.current && currentPurchaseOrderIdRef.current === capturedPurchaseOrderId) setBusy(false); }
  }

  function submit() {
    if (submitLockRef.current) return;
    submitLockRef.current = true;
    const payload = buildPayload();
    if (!payload) { submitLockRef.current = false; return; }
    const next = { key: crypto.randomUUID(), payload, uncertain: false };
    setAttempt(next); void send(next);
  }
  function retry(current: Attempt) { if (submitLockRef.current) return; submitLockRef.current = true; void send(current); }
  function abandon() { setAttempt(null); setGeneralError(null); }
  if (!open) return null;

  const frozen = attempt !== null;
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-labelledby="receive-po-title" data-testid="receive-po-dialog">
      <div ref={dialogRef} className="max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-xl border border-border bg-card p-5 shadow-lg">
        <h2 id="receive-po-title" ref={titleRef} tabIndex={-1} className="font-display text-xl">Receive {purchaseOrder.po_number}</h2>
        <p className="mt-1 text-sm text-muted-foreground">Enter quantities in each Purchase Order line’s ordered unit. Posting is immutable.</p>
        {generalError && <div className="mt-4" role="alert"><ErrorBanner message={generalError} /></div>}
        {optionsError && <div className="mt-4" role="alert"><ErrorBanner message={optionsError} /></div>}
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field label="Warehouse" error={errors.warehouse} errorId="receipt-error-warehouse"><select aria-invalid={Boolean(errors.warehouse)} aria-describedby={errors.warehouse ? 'receipt-error-warehouse' : undefined} value={warehouseId} disabled={frozen || busy || Boolean(optionsError)} onChange={(e) => changeWarehouse(e.target.value)} className="w-full rounded-md border bg-background p-2"><option value="">Select warehouse</option>{warehouses.map((w) => <option key={w.id} value={w.id}>{w.name} ({w.code})</option>)}</select></Field>
          <Field label="Supplier delivery reference" error={errors.supplierReference} errorId="receipt-error-supplier-reference"><input aria-invalid={Boolean(errors.supplierReference)} aria-describedby={errors.supplierReference ? 'receipt-error-supplier-reference' : undefined} value={supplierReference} disabled={frozen || busy} onChange={(e) => setSupplierReference(e.target.value)} className="w-full rounded-md border bg-background p-2" /></Field>
          <Field label="Received date and time" error={errors.receivedAt} errorId="receipt-error-received-at"><input aria-invalid={Boolean(errors.receivedAt)} aria-describedby={errors.receivedAt ? 'receipt-error-received-at' : undefined} type="datetime-local" value={receivedAt} disabled={frozen || busy} onChange={(e) => setReceivedAt(e.target.value)} className="w-full rounded-md border bg-background p-2" /></Field>
          <Field label="Notes" error={errors.notes} errorId="receipt-error-notes"><textarea aria-invalid={Boolean(errors.notes)} aria-describedby={errors.notes ? 'receipt-error-notes' : undefined} value={notes} disabled={frozen || busy} onChange={(e) => setNotes(e.target.value)} className="w-full rounded-md border bg-background p-2" /></Field>
        </div>
        {locationError && <p className="mt-3 text-sm text-muted-foreground">{locationError} You may continue without a location.</p>}
        <fieldset className="mt-5 space-y-3" disabled={frozen || busy}><legend className="font-medium">Purchase Order lines</legend>{errors.lines && <p className="text-sm text-destructive">{errors.lines}</p>}
          {purchaseOrder.lines.map((line) => { const value = lines[line.id]; const remaining = subtractPurchaseOrderDecimals(line.ordered_quantity, line.received_quantity); return (
            <div key={line.id} className="rounded-lg border p-4"><label className="flex gap-2 font-medium"><input type="checkbox" checked={value.included} disabled={comparePurchaseOrderDecimals(remaining, '0') <= 0} onChange={(e) => updateLine(line.id, { included: e.target.checked })} />{line.line_number}. {line.item_name}</label><p className="mt-1 text-sm text-muted-foreground">Ordered {formatPurchaseOrderDecimal(line.ordered_quantity)} · received {formatPurchaseOrderDecimal(line.received_quantity)} · remaining {formatPurchaseOrderDecimal(remaining)} {line.ordered_unit}</p>
              {value.included && <div className="mt-3 grid gap-3 sm:grid-cols-4"><Field label={`Quantity (${line.ordered_unit})`} error={errors[`${line.id}.quantity`]} errorId={`receipt-error-${line.id}-quantity`}><input aria-invalid={Boolean(errors[`${line.id}.quantity`])} aria-describedby={errors[`${line.id}.quantity`] ? `receipt-error-${line.id}-quantity` : undefined} inputMode="decimal" value={value.quantity} onChange={(e) => updateLine(line.id, { quantity: e.target.value })} className="w-full rounded-md border bg-background p-2" /></Field><Field label="Lot code" error={errors[`${line.id}.lot`]} errorId={`receipt-error-${line.id}-lot`}><input aria-invalid={Boolean(errors[`${line.id}.lot`])} aria-describedby={errors[`${line.id}.lot`] ? `receipt-error-${line.id}-lot` : undefined} value={value.lotCode} onChange={(e) => updateLine(line.id, { lotCode: e.target.value })} className="w-full rounded-md border bg-background p-2" /></Field><Field label="Storage location"><select value={value.storageLocationId} disabled={!warehouseId || Boolean(locationError)} onChange={(e) => updateLine(line.id, { storageLocationId: e.target.value })} className="w-full rounded-md border bg-background p-2"><option value="">None</option>{locations.map((loc) => <option key={loc.id} value={loc.id}>{loc.name} ({loc.code})</option>)}</select></Field><Field label="Expiry date"><input type="date" value={value.expiryDate} onChange={(e) => updateLine(line.id, { expiryDate: e.target.value })} className="w-full rounded-md border bg-background p-2" /></Field></div>}
            </div>); })}
        </fieldset>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          {attempt && <button type="button" disabled={busy} onClick={abandon} className="rounded-md border border-destructive px-3 py-2 text-sm text-destructive">Abandon attempt</button>}
          <button type="button" disabled={busy || Boolean(attempt?.uncertain)} onClick={onClose} className="rounded-md border px-3 py-2 text-sm">Cancel</button>
          {attempt?.uncertain ? <button type="button" disabled={busy} onClick={() => retry(attempt)} className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground">{busy ? 'Retrying…' : 'Retry same receipt'}</button> : <button type="button" disabled={busy || frozen || Boolean(optionsError)} onClick={submit} className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground">{busy ? 'Posting…' : 'Post receipt'}</button>}
        </div>
      </div>
    </div>
  );
}

function Field({ label, error, errorId, children }: { label: string; error?: string; errorId?: string; children: React.ReactNode }) { return <label className="block text-sm"><span className="mb-1 block text-muted-foreground">{label}</span>{children}{error && <span id={errorId} className="mt-1 block text-destructive">{error}</span>}</label>; }
