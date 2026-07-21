import { FormEvent, useState } from 'react';
import type { InventoryItem, ItemCategory, StockUnit } from '@/lib/inventory-items';
import { ITEM_CATEGORIES, STOCK_UNITS, categoryLabel } from '@/lib/inventory-items';

/**
 * Sprint 5.3 — combined create + edit form.
 *
 * Create-only fields (immutable after creation): `code`,
 * `category`, `canonical_unit`. The backend `InventoryItemUpdate`
 * schema does not include these, so we render them read-only in
 * edit mode and rely on the backend as source of truth.
 *
 * Edit-only field: `is_active` (backend accepts it via PATCH).
 *
 * We intentionally do NOT accept supplier/brand/price/etc. — see
 * the sprint's truthful-data mandate.
 */
export type ItemFormMode = 'create' | 'edit';

export interface ItemFormValues {
  name: string;
  code: string;
  description: string;
  category: ItemCategory;
  canonical_unit: StockUnit;
  sku: string;
  is_active: boolean;
}

export function itemFormDefaults(item: InventoryItem | null): ItemFormValues {
  return {
    name: item?.name ?? '',
    code: item?.code ?? '',
    description: item?.description ?? '',
    category: item?.category ?? 'feed',
    canonical_unit: item?.canonical_unit ?? 'kg',
    sku: item?.sku ?? '',
    is_active: item?.is_active ?? true,
  };
}

export type ItemFormPayload =
  | {
      mode: 'create';
      name: string;
      code: string;
      description: string | null;
      category: ItemCategory;
      canonical_unit: StockUnit;
      sku: string | null;
    }
  | {
      mode: 'edit';
      name: string;
      description: string | null;
      sku: string | null;
      is_active: boolean;
    };

export function InventoryItemForm({
  mode,
  item,
  organizationName,
  busy,
  errorMessage,
  onSubmit,
  onCancel,
}: {
  mode: ItemFormMode;
  item?: InventoryItem | null;
  organizationName?: string | null;
  busy?: boolean;
  errorMessage?: string | null;
  onSubmit: (payload: ItemFormPayload) => void;
  onCancel?: () => void;
}) {
  const [values, setValues] = useState<ItemFormValues>(itemFormDefaults(item ?? null));
  const testIdRoot = `item-form-${mode}`;

  function nullable(v: string): string | null {
    const trimmed = v.trim();
    return trimmed === '' ? null : trimmed;
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!values.name.trim()) return;
    if (mode === 'create') {
      if (!values.code.trim()) return;
      onSubmit({
        mode: 'create',
        name: values.name.trim(),
        code: values.code.trim(),
        description: nullable(values.description),
        category: values.category,
        canonical_unit: values.canonical_unit,
        sku: nullable(values.sku),
      });
    } else {
      onSubmit({
        mode: 'edit',
        name: values.name.trim(),
        description: nullable(values.description),
        sku: nullable(values.sku),
        is_active: values.is_active,
      });
    }
  }

  return (
    <form
      onSubmit={submit}
      className="grid gap-3 rounded-2xl border border-border p-4 sm:grid-cols-2"
      data-testid={testIdRoot}
    >
      <label className="block text-sm sm:col-span-2">
        Name <span className="text-destructive">*</span>
        <input
          data-testid={`${testIdRoot}-name`}
          value={values.name}
          onChange={(e) => setValues({ ...values, name: e.target.value })}
          required
          maxLength={255}
          className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1"
        />
      </label>
      <label className="block text-sm">
        Code {mode === 'create' && <span className="text-destructive">*</span>}
        <input
          data-testid={`${testIdRoot}-code`}
          value={values.code}
          onChange={(e) => setValues({ ...values, code: e.target.value })}
          required={mode === 'create'}
          disabled={mode === 'edit'}
          maxLength={64}
          className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1 disabled:opacity-70"
        />
        {mode === 'edit' && (
          <span className="mt-0.5 block text-[10px] text-muted-foreground">
            Code is immutable after creation.
          </span>
        )}
      </label>
      <label className="block text-sm">
        SKU
        <input
          data-testid={`${testIdRoot}-sku`}
          value={values.sku}
          onChange={(e) => setValues({ ...values, sku: e.target.value })}
          maxLength={128}
          className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1"
        />
      </label>
      <label className="block text-sm">
        Category
        <select
          data-testid={`${testIdRoot}-category`}
          value={values.category}
          onChange={(e) => setValues({ ...values, category: e.target.value as ItemCategory })}
          disabled={mode === 'edit'}
          className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1 disabled:opacity-70"
        >
          {ITEM_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {categoryLabel(c)}
            </option>
          ))}
        </select>
        {mode === 'edit' && (
          <span className="mt-0.5 block text-[10px] text-muted-foreground">
            Category is immutable after creation.
          </span>
        )}
      </label>
      <label className="block text-sm">
        Unit
        <select
          data-testid={`${testIdRoot}-unit`}
          value={values.canonical_unit}
          onChange={(e) => setValues({ ...values, canonical_unit: e.target.value as StockUnit })}
          disabled={mode === 'edit'}
          className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1 disabled:opacity-70"
        >
          {STOCK_UNITS.map((u) => (
            <option key={u} value={u}>
              {u}
            </option>
          ))}
        </select>
        {mode === 'edit' && (
          <span className="mt-0.5 block text-[10px] text-muted-foreground">
            Unit is immutable after creation.
          </span>
        )}
      </label>
      <label className="block text-sm sm:col-span-2">
        Description
        <textarea
          data-testid={`${testIdRoot}-description`}
          value={values.description}
          onChange={(e) => setValues({ ...values, description: e.target.value })}
          maxLength={1000}
          rows={2}
          className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1"
        />
      </label>
      {mode === 'edit' && (
        <label
          className="flex items-center gap-2 text-sm sm:col-span-2"
          data-testid={`${testIdRoot}-active-wrapper`}
        >
          <input
            type="checkbox"
            data-testid={`${testIdRoot}-active`}
            checked={values.is_active}
            onChange={(e) => setValues({ ...values, is_active: e.target.checked })}
          />
          <span>Active</span>
        </label>
      )}
      {organizationName && mode === 'create' && (
        <div className="sm:col-span-2 rounded-md bg-secondary/40 px-3 py-2 text-xs text-muted-foreground">
          This item will be created in <strong>{organizationName}</strong>. Organization cannot be
          changed after creation.
        </div>
      )}
      {errorMessage && (
        <p
          role="alert"
          data-testid={`${testIdRoot}-error`}
          className="sm:col-span-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {errorMessage}
        </p>
      )}
      <div className="sm:col-span-2 flex flex-wrap justify-end gap-2">
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            data-testid={`${testIdRoot}-cancel`}
            className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-secondary disabled:opacity-60"
          >
            Cancel
          </button>
        )}
        <button
          type="submit"
          disabled={busy}
          data-testid={`${testIdRoot}-submit`}
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-60"
        >
          {busy ? 'Saving…' : mode === 'create' ? 'Create item' : 'Save changes'}
        </button>
      </div>
    </form>
  );
}
