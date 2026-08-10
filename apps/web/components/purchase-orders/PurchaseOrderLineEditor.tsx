import type { ReactNode } from 'react';
import type { InventoryItem } from '@/lib/inventory-items';
import { STOCK_UNITS } from '@/lib/inventory-items';

export interface PurchaseOrderLineFormValue {
  rowKey: string;
  id?: string;
  inventoryItemId: string;
  orderedQuantity: string;
  orderedUnit: string;
  unitPrice: string;
  description: string;
  lineNote: string;
}

export function PurchaseOrderLineEditor({
  lines,
  items,
  errors,
  disabled,
  onChange,
  onAdd,
}: {
  lines: PurchaseOrderLineFormValue[];
  items: InventoryItem[];
  errors: Record<string, string>;
  disabled: boolean;
  onChange: (lines: PurchaseOrderLineFormValue[]) => void;
  onAdd: () => void;
}) {
  function update(rowKey: string, patch: Partial<PurchaseOrderLineFormValue>) {
    onChange(lines.map((line) => (line.rowKey === rowKey ? { ...line, ...patch } : line)));
  }

  function move(index: number, direction: -1 | 1) {
    const destination = index + direction;
    if (destination < 0 || destination >= lines.length) return;
    const next = [...lines];
    [next[index], next[destination]] = [next[destination], next[index]];
    onChange(next);
  }

  return (
    <fieldset className="space-y-3" disabled={disabled}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <legend className="font-display text-lg">Lines</legend>
        <button
          type="button"
          onClick={onAdd}
          data-testid="po-line-add"
          className="rounded-md border border-border px-3 py-1.5 text-sm"
        >
          Add line
        </button>
      </div>
      {errors.lines && <FieldError id="po-error-lines" message={errors.lines} />}
      {lines.length === 0 ? (
        <p className="text-sm text-muted-foreground">A Draft may be saved without lines.</p>
      ) : (
        <div className="space-y-4">
          {lines.map((line, index) => {
            const prefix = `lines.${index}`;
            const item = items.find((candidate) => candidate.id === line.inventoryItemId);
            return (
              <section
                key={line.rowKey}
                className="grid gap-3 rounded-xl border border-border p-4 md:grid-cols-12"
                data-testid={`po-line-${line.rowKey}`}
              >
                <p className="text-sm font-medium md:col-span-12">Line {index + 1}</p>
                <Field
                  label="Inventory item"
                  error={errors[`${prefix}.inventory_item_id`]}
                  errorId={`po-line-${index}-item-error`}
                  span="md:col-span-6"
                >
                  <select
                    value={line.inventoryItemId}
                    onChange={(event) => {
                      const selected = items.find(
                        (candidate) => candidate.id === event.target.value,
                      );
                      update(line.rowKey, {
                        inventoryItemId: event.target.value,
                        orderedUnit: selected?.canonical_unit ?? line.orderedUnit,
                      });
                    }}
                    data-testid={`po-line-${index}-item`}
                    aria-label={`Line ${index + 1} inventory item`}
                    aria-invalid={Boolean(errors[`${prefix}.inventory_item_id`])}
                    aria-describedby={
                      errors[`${prefix}.inventory_item_id`]
                        ? `po-line-${index}-item-error`
                        : undefined
                    }
                  >
                    <option value="">Select an active item</option>
                    {items.map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>
                        {candidate.code} — {candidate.name}
                        {candidate.sku ? ` (${candidate.sku})` : ''} · {candidate.canonical_unit}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field
                  label="Quantity"
                  error={errors[`${prefix}.ordered_quantity`]}
                  errorId={`po-line-${index}-quantity-error`}
                  span="md:col-span-2"
                >
                  <input
                    inputMode="decimal"
                    value={line.orderedQuantity}
                    onChange={(event) =>
                      update(line.rowKey, { orderedQuantity: event.target.value })
                    }
                    data-testid={`po-line-${index}-quantity`}
                    aria-label={`Line ${index + 1} quantity`}
                    aria-invalid={Boolean(errors[`${prefix}.ordered_quantity`])}
                    aria-describedby={
                      errors[`${prefix}.ordered_quantity`]
                        ? `po-line-${index}-quantity-error`
                        : undefined
                    }
                  />
                </Field>
                <Field
                  label="Unit"
                  error={errors[`${prefix}.ordered_unit`]}
                  errorId={`po-line-${index}-unit-error`}
                  span="md:col-span-2"
                >
                  <select
                    value={line.orderedUnit}
                    onChange={(event) => update(line.rowKey, { orderedUnit: event.target.value })}
                    data-testid={`po-line-${index}-unit`}
                    aria-label={`Line ${index + 1} unit`}
                    aria-invalid={Boolean(errors[`${prefix}.ordered_unit`])}
                    aria-describedby={
                      errors[`${prefix}.ordered_unit`] ? `po-line-${index}-unit-error` : undefined
                    }
                  >
                    {STOCK_UNITS.map((unit) => (
                      <option key={unit} value={unit}>
                        {unit}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field
                  label="Unit price"
                  error={errors[`${prefix}.unit_price`]}
                  errorId={`po-line-${index}-price-error`}
                  span="md:col-span-2"
                >
                  <input
                    inputMode="decimal"
                    value={line.unitPrice}
                    onChange={(event) => update(line.rowKey, { unitPrice: event.target.value })}
                    data-testid={`po-line-${index}-price`}
                    aria-label={`Line ${index + 1} unit price`}
                    aria-invalid={Boolean(errors[`${prefix}.unit_price`])}
                    aria-describedby={
                      errors[`${prefix}.unit_price`] ? `po-line-${index}-price-error` : undefined
                    }
                  />
                </Field>
                <Field
                  label="Description"
                  error={errors[`${prefix}.description`]}
                  errorId={`po-line-${index}-description-error`}
                  span="md:col-span-6"
                >
                  <input
                    value={line.description}
                    maxLength={500}
                    onChange={(event) => update(line.rowKey, { description: event.target.value })}
                    aria-label={`Line ${index + 1} description`}
                    aria-invalid={Boolean(errors[`${prefix}.description`])}
                    aria-describedby={
                      errors[`${prefix}.description`]
                        ? `po-line-${index}-description-error`
                        : undefined
                    }
                  />
                </Field>
                <Field
                  label="Line note"
                  error={errors[`${prefix}.line_note`]}
                  errorId={`po-line-${index}-note-error`}
                  span="md:col-span-6"
                >
                  <input
                    value={line.lineNote}
                    maxLength={1000}
                    onChange={(event) => update(line.rowKey, { lineNote: event.target.value })}
                    aria-label={`Line ${index + 1} note`}
                    aria-invalid={Boolean(errors[`${prefix}.line_note`])}
                    aria-describedby={
                      errors[`${prefix}.line_note`] ? `po-line-${index}-note-error` : undefined
                    }
                  />
                </Field>
                {item && (
                  <p className="text-xs text-muted-foreground md:col-span-6">
                    Canonical unit: {item.canonical_unit}. Stock and lot balances are intentionally
                    not shown.
                  </p>
                )}
                <div className="flex flex-wrap justify-end gap-2 md:col-span-6">
                  <button
                    type="button"
                    onClick={() => move(index, -1)}
                    disabled={index === 0}
                    aria-label={`Move line ${index + 1} up`}
                    className="rounded border px-2 py-1 text-xs"
                  >
                    Up
                  </button>
                  <button
                    type="button"
                    onClick={() => move(index, 1)}
                    disabled={index === lines.length - 1}
                    aria-label={`Move line ${index + 1} down`}
                    className="rounded border px-2 py-1 text-xs"
                  >
                    Down
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      onChange(lines.filter((candidate) => candidate.rowKey !== line.rowKey))
                    }
                    aria-label={`Remove line ${index + 1}`}
                    className="rounded border border-destructive px-2 py-1 text-xs text-destructive"
                  >
                    Remove
                  </button>
                </div>
              </section>
            );
          })}
        </div>
      )}
    </fieldset>
  );
}

function Field({
  label,
  error,
  errorId,
  span,
  children,
}: {
  label: string;
  error?: string;
  errorId: string;
  span: string;
  children: ReactNode;
}) {
  return (
    <label className={`text-sm ${span}`}>
      <span className="mb-1 block text-muted-foreground">{label}</span>
      <span className="block [&_input]:w-full [&_input]:rounded-md [&_input]:border [&_input]:bg-background [&_input]:px-3 [&_input]:py-2 [&_select]:w-full [&_select]:rounded-md [&_select]:border [&_select]:bg-background [&_select]:px-3 [&_select]:py-2">
        {children}
      </span>
      {error && <FieldError id={errorId} message={error} />}
    </label>
  );
}

function FieldError({ id, message }: { id: string; message: string }) {
  return (
    <span id={id || undefined} className="mt-1 block text-xs text-destructive" role="alert">
      {message}
    </span>
  );
}
