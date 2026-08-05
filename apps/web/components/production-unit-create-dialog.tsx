'use client';

import { FormEvent, useEffect, useRef, useState } from 'react';
import type { ProductionUnitType } from '@/lib/types';

export type ProductionUnitStatus = 'active' | 'maintenance' | 'closed';

export interface ProductionUnitCreateValues {
  unit_type_id: string;
  name: string;
  code: string;
  capacity: number | null;
  status: ProductionUnitStatus;
}

export type ProductionUnitFieldErrors = Partial<
  Record<'unit_type_id' | 'name' | 'code' | 'capacity' | 'status', string>
>;

const INITIAL_VALUES = {
  unitTypeId: '',
  name: '',
  code: '',
  capacity: '',
  status: 'active' as ProductionUnitStatus,
};

export function ProductionUnitCreateDialog({
  open,
  unitTypes,
  busy,
  errorMessage,
  fieldErrors = {},
  onSubmit,
  onClose,
}: {
  open: boolean;
  unitTypes: ProductionUnitType[] | null;
  busy: boolean;
  errorMessage?: string | null;
  fieldErrors?: ProductionUnitFieldErrors;
  onSubmit: (values: ProductionUnitCreateValues) => void;
  onClose: () => void;
}) {
  const [values, setValues] = useState(INITIAL_VALUES);
  const [localErrors, setLocalErrors] = useState<ProductionUnitFieldErrors>({});
  const dialogRef = useRef<HTMLDivElement>(null);
  const firstFieldRef = useRef<HTMLSelectElement>(null);
  const busyRef = useRef(busy);
  busyRef.current = busy;

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    setValues(INITIAL_VALUES);
    setLocalErrors({});
    window.setTimeout(() => firstFieldRef.current?.focus(), 0);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busyRef.current) {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])',
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      previous?.focus();
    };
  }, [onClose, open]);

  if (!open) return null;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const errors: ProductionUnitFieldErrors = {};
    if (!values.unitTypeId) errors.unit_type_id = 'Select a unit type.';
    if (!values.name.trim()) errors.name = 'Name is required.';
    if (!values.code.trim()) errors.code = 'Code is required.';

    let capacity: number | null = null;
    if (values.capacity.trim()) {
      capacity = Number(values.capacity);
      if (!Number.isInteger(capacity) || capacity < 0) {
        errors.capacity = 'Capacity must be a whole number of zero or greater.';
      }
    }

    setLocalErrors(errors);
    if (Object.keys(errors).length > 0) return;
    onSubmit({
      unit_type_id: values.unitTypeId,
      name: values.name.trim(),
      code: values.code.trim(),
      capacity,
      status: values.status,
    });
  }

  const errors = { ...fieldErrors, ...localErrors };
  const fieldClass =
    'mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 disabled:cursor-not-allowed disabled:opacity-60';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-unit-title"
        data-testid="production-unit-create-dialog"
        className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-border bg-background p-6 shadow-xl"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="create-unit-title" className="font-display text-2xl">
              Create Production Unit
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Add an operational unit to this production site.
            </p>
          </div>
          <button
            type="button"
            aria-label="Close create unit dialog"
            onClick={onClose}
            disabled={busy}
            className="rounded-md px-2 py-1 text-muted-foreground hover:bg-secondary disabled:opacity-60"
          >
            ×
          </button>
        </div>

        <form onSubmit={submit} className="mt-5 grid gap-4 sm:grid-cols-2" noValidate>
          <label className="block text-sm sm:col-span-2">
            Unit Type <span className="text-destructive">*</span>
            <select
              ref={firstFieldRef}
              data-testid="production-unit-field-type"
              value={values.unitTypeId}
              onChange={(e) => {
                setValues({ ...values, unitTypeId: e.target.value });
                setLocalErrors({ ...localErrors, unit_type_id: undefined });
              }}
              disabled={busy || unitTypes === null || unitTypes.length === 0}
              aria-invalid={Boolean(errors.unit_type_id)}
              aria-describedby={errors.unit_type_id ? 'create-unit-type-error' : undefined}
              className={fieldClass}
            >
              <option value="">
                {unitTypes === null
                  ? 'Loading unit types…'
                  : unitTypes.length === 0
                    ? 'No unit types available'
                    : 'Select a unit type'}
              </option>
              {unitTypes?.map((type) => (
                <option key={type.id} value={type.id}>
                  {type.display_name} — {type.is_system ? 'System' : 'Organization'}
                </option>
              ))}
            </select>
            {errors.unit_type_id && (
              <FieldError id="create-unit-type-error" message={errors.unit_type_id} />
            )}
            {unitTypes?.length === 0 && (
              <p className="mt-1 text-xs text-muted-foreground">
                No system or organization unit types are available. Ask an administrator to review
                reference data and permissions.
              </p>
            )}
          </label>

          <label className="block text-sm">
            Name <span className="text-destructive">*</span>
            <input
              data-testid="production-unit-field-name"
              value={values.name}
              maxLength={255}
              onChange={(e) => setValues({ ...values, name: e.target.value })}
              aria-invalid={Boolean(errors.name)}
              aria-describedby={errors.name ? 'create-unit-name-error' : undefined}
              disabled={busy}
              className={fieldClass}
            />
            {errors.name && <FieldError id="create-unit-name-error" message={errors.name} />}
          </label>

          <label className="block text-sm">
            Code <span className="text-destructive">*</span>
            <input
              data-testid="production-unit-field-code"
              value={values.code}
              maxLength={64}
              onChange={(e) => setValues({ ...values, code: e.target.value })}
              aria-invalid={Boolean(errors.code)}
              aria-describedby={errors.code ? 'create-unit-code-error' : undefined}
              disabled={busy}
              className={fieldClass}
            />
            {errors.code && <FieldError id="create-unit-code-error" message={errors.code} />}
          </label>

          <label className="block text-sm">
            Capacity
            <input
              data-testid="production-unit-field-capacity"
              type="number"
              min="0"
              step="1"
              value={values.capacity}
              onChange={(e) => setValues({ ...values, capacity: e.target.value })}
              aria-invalid={Boolean(errors.capacity)}
              aria-describedby={errors.capacity ? 'create-unit-capacity-error' : undefined}
              disabled={busy}
              className={fieldClass}
            />
            {errors.capacity && (
              <FieldError id="create-unit-capacity-error" message={errors.capacity} />
            )}
          </label>

          <label className="block text-sm">
            Status
            <select
              data-testid="production-unit-field-status"
              value={values.status}
              onChange={(e) =>
                setValues({ ...values, status: e.target.value as ProductionUnitStatus })
              }
              disabled={busy}
              aria-invalid={Boolean(errors.status)}
              aria-describedby={errors.status ? 'create-unit-status-error' : undefined}
              className={fieldClass}
            >
              <option value="active">Active</option>
              <option value="maintenance">Maintenance</option>
              <option value="closed">Closed</option>
            </select>
            {errors.status && <FieldError id="create-unit-status-error" message={errors.status} />}
          </label>

          {errorMessage && (
            <p
              role="alert"
              data-testid="production-unit-create-error"
              className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive sm:col-span-2"
            >
              {errorMessage}
            </p>
          )}

          <div className="flex justify-end gap-2 sm:col-span-2">
            <button
              type="button"
              data-testid="production-unit-create-cancel"
              onClick={onClose}
              disabled={busy}
              className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-secondary disabled:opacity-60"
            >
              Cancel
            </button>
            <button
              type="submit"
              data-testid="production-unit-create-submit"
              disabled={busy || unitTypes === null || unitTypes.length === 0}
              className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy ? 'Creating…' : 'Create Unit'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function FieldError({ id, message }: { id: string; message: string }) {
  return (
    <span id={id} role="alert" className="mt-1 block text-xs text-destructive">
      {message}
    </span>
  );
}
