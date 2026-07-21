import { FormEvent, useState } from 'react';
import type { Warehouse, WarehouseStatus } from '@/lib/inventory-warehouses';

/**
 * Sprint 5.2 — combined create + edit form.
 *
 * The `mode` prop drives which fields are shown and which are
 * immutable:
 *   - `create`: name, code, description, address are user-set.
 *              `organization` is inferred from the URL (parent
 *              passes it in) and never editable here.
 *              `site_id` is deliberately absent — the backend
 *              cannot list sites per-org, so we do not offer a
 *              picker.
 *   - `edit`:  name, description, address, status are editable.
 *              code / organization / warehouse-id are shown as
 *              read-only technical fields.
 *
 * Validation is intentionally minimal (required name+code and
 * one duplicate-code error surfaced by the caller). The backend
 * is authoritative for uniqueness and permission checks; the
 * form only pre-empts obviously invalid submissions.
 */

export type WarehouseFormMode = 'create' | 'edit';

export interface WarehouseFormValues {
  name: string;
  code: string;
  description: string;
  address: string;
  status: WarehouseStatus;
}

export function warehouseFormDefaults(warehouse: Warehouse | null): WarehouseFormValues {
  return {
    name: warehouse?.name ?? '',
    code: warehouse?.code ?? '',
    description: warehouse?.description ?? '',
    address: warehouse?.address ?? '',
    status: warehouse?.status ?? 'active',
  };
}

export function WarehouseForm({
  mode,
  warehouse,
  organizationName,
  busy,
  errorMessage,
  onSubmit,
  onCancel,
}: {
  mode: WarehouseFormMode;
  warehouse?: Warehouse | null;
  organizationName?: string | null;
  busy?: boolean;
  errorMessage?: string | null;
  onSubmit: (
    payload:
      | ({ mode: 'create' } & Pick<
          WarehouseFormValues,
          'name' | 'code' | 'description' | 'address'
        >)
      | ({ mode: 'edit' } & Pick<
          WarehouseFormValues,
          'name' | 'description' | 'address' | 'status'
        >),
  ) => void;
  onCancel?: () => void;
}) {
  const [values, setValues] = useState<WarehouseFormValues>(
    warehouseFormDefaults(warehouse ?? null),
  );

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
        description: values.description.trim(),
        address: values.address.trim(),
      });
    } else {
      onSubmit({
        mode: 'edit',
        name: values.name.trim(),
        description: values.description.trim(),
        address: values.address.trim(),
        status: values.status,
      });
    }
  }

  const testIdRoot = `warehouse-form-${mode}`;

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
          className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1 disabled:opacity-70"
        />
        {mode === 'edit' && (
          <span className="mt-0.5 block text-[10px] text-muted-foreground">
            Code is immutable after creation.
          </span>
        )}
      </label>
      {mode === 'edit' && (
        <label className="block text-sm">
          Status
          <select
            data-testid={`${testIdRoot}-status`}
            value={values.status}
            onChange={(e) => setValues({ ...values, status: e.target.value as WarehouseStatus })}
            className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1"
          >
            <option value="active">Operational</option>
            <option value="maintenance">Maintenance</option>
            <option value="closed">Closed</option>
          </select>
        </label>
      )}
      <label className="block text-sm sm:col-span-2">
        Description
        <textarea
          data-testid={`${testIdRoot}-description`}
          value={values.description}
          onChange={(e) => setValues({ ...values, description: e.target.value })}
          rows={2}
          className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1"
        />
      </label>
      <label className="block text-sm sm:col-span-2">
        Address
        <input
          data-testid={`${testIdRoot}-address`}
          value={values.address}
          onChange={(e) => setValues({ ...values, address: e.target.value })}
          className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1"
        />
      </label>
      {organizationName && mode === 'create' && (
        <div className="sm:col-span-2 rounded-md bg-secondary/40 px-3 py-2 text-xs text-muted-foreground">
          This warehouse will be created in <strong>{organizationName}</strong>. Organization cannot
          be changed after creation.
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
          {busy ? 'Saving…' : mode === 'create' ? 'Create warehouse' : 'Save changes'}
        </button>
      </div>
    </form>
  );
}
