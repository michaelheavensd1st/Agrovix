'use client';

import { FormEvent, useEffect, useRef, useState } from 'react';

export interface ProductionBatchCreateValues {
  code: string;
  species: string | null;
  planned_at: string | null;
  expected_quantity: number | null;
  notes: string | null;
}

export type ProductionBatchFieldErrors = Partial<
  Record<'code' | 'species' | 'planned_at' | 'expected_quantity' | 'notes', string>
>;

const INITIAL_VALUES = {
  code: '',
  species: '',
  plannedAt: '',
  expectedQuantity: '',
  notes: '',
};

export function ProductionBatchCreateDialog({
  open,
  busy,
  errorMessage,
  fieldErrors = {},
  onSubmit,
  onClose,
}: {
  open: boolean;
  busy: boolean;
  errorMessage?: string | null;
  fieldErrors?: ProductionBatchFieldErrors;
  onSubmit: (values: ProductionBatchCreateValues) => void;
  onClose: () => void;
}) {
  const [values, setValues] = useState(INITIAL_VALUES);
  const [localErrors, setLocalErrors] = useState<ProductionBatchFieldErrors>({});
  const dialogRef = useRef<HTMLDivElement>(null);
  const firstFieldRef = useRef<HTMLInputElement>(null);
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
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled])',
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
    const errors: ProductionBatchFieldErrors = {};
    if (!values.code.trim()) errors.code = 'Code is required.';

    let expectedQuantity: number | null = null;
    if (values.expectedQuantity.trim()) {
      expectedQuantity = Number(values.expectedQuantity);
      if (!Number.isInteger(expectedQuantity) || expectedQuantity < 0) {
        errors.expected_quantity = 'Expected quantity must be a whole number of zero or greater.';
      }
    }

    let plannedAt: string | null = null;
    if (values.plannedAt) {
      const parsed = new Date(values.plannedAt);
      if (Number.isNaN(parsed.getTime()))
        errors.planned_at = 'Enter a valid planned date and time.';
      else plannedAt = parsed.toISOString();
    }

    setLocalErrors(errors);
    if (Object.keys(errors).length > 0) return;
    onSubmit({
      code: values.code.trim(),
      species: values.species.trim() || null,
      planned_at: plannedAt,
      expected_quantity: expectedQuantity,
      notes: values.notes.trim() || null,
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
        aria-labelledby="create-batch-title"
        data-testid="production-batch-create-dialog"
        className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-border bg-background p-6 shadow-xl"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="create-batch-title" className="font-display text-2xl">
              Create Production Batch
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Create a planned production cycle for this unit.
            </p>
          </div>
          <button
            type="button"
            aria-label="Close create batch dialog"
            onClick={onClose}
            disabled={busy}
            className="rounded-md px-2 py-1 text-muted-foreground hover:bg-secondary disabled:opacity-60"
          >
            ×
          </button>
        </div>

        <form onSubmit={submit} className="mt-5 grid gap-4 sm:grid-cols-2" noValidate>
          <label className="block text-sm">
            Code <span className="text-destructive">*</span>
            <input
              ref={firstFieldRef}
              data-testid="production-batch-field-code"
              value={values.code}
              maxLength={64}
              onChange={(event) => {
                setValues({ ...values, code: event.target.value });
                setLocalErrors({ ...localErrors, code: undefined });
              }}
              aria-invalid={Boolean(errors.code)}
              aria-describedby={errors.code ? 'create-batch-code-error' : undefined}
              disabled={busy}
              className={fieldClass}
            />
            {errors.code && <FieldError id="create-batch-code-error" message={errors.code} />}
          </label>

          <label className="block text-sm">
            Species <span className="text-xs text-muted-foreground">(optional)</span>
            <input
              data-testid="production-batch-field-species"
              value={values.species}
              maxLength={255}
              onChange={(event) => setValues({ ...values, species: event.target.value })}
              aria-invalid={Boolean(errors.species)}
              aria-describedby={errors.species ? 'create-batch-species-error' : undefined}
              disabled={busy}
              className={fieldClass}
            />
            {errors.species && (
              <FieldError id="create-batch-species-error" message={errors.species} />
            )}
          </label>

          <label className="block text-sm">
            Planned date and time <span className="text-xs text-muted-foreground">(optional)</span>
            <input
              data-testid="production-batch-field-planned-at"
              type="datetime-local"
              value={values.plannedAt}
              onChange={(event) => setValues({ ...values, plannedAt: event.target.value })}
              aria-invalid={Boolean(errors.planned_at)}
              aria-describedby={errors.planned_at ? 'create-batch-planned-at-error' : undefined}
              disabled={busy}
              className={fieldClass}
            />
            {errors.planned_at && (
              <FieldError id="create-batch-planned-at-error" message={errors.planned_at} />
            )}
          </label>

          <label className="block text-sm">
            Expected quantity <span className="text-xs text-muted-foreground">(optional)</span>
            <input
              data-testid="production-batch-field-expected-quantity"
              type="number"
              min="0"
              step="1"
              value={values.expectedQuantity}
              onChange={(event) => setValues({ ...values, expectedQuantity: event.target.value })}
              aria-invalid={Boolean(errors.expected_quantity)}
              aria-describedby={
                errors.expected_quantity ? 'create-batch-expected-quantity-error' : undefined
              }
              disabled={busy}
              className={fieldClass}
            />
            {errors.expected_quantity && (
              <FieldError
                id="create-batch-expected-quantity-error"
                message={errors.expected_quantity}
              />
            )}
          </label>

          <label className="block text-sm sm:col-span-2">
            Notes <span className="text-xs text-muted-foreground">(optional)</span>
            <textarea
              data-testid="production-batch-field-notes"
              value={values.notes}
              maxLength={2000}
              rows={3}
              onChange={(event) => setValues({ ...values, notes: event.target.value })}
              aria-invalid={Boolean(errors.notes)}
              aria-describedby={errors.notes ? 'create-batch-notes-error' : undefined}
              disabled={busy}
              className={fieldClass}
            />
            {errors.notes && <FieldError id="create-batch-notes-error" message={errors.notes} />}
          </label>

          {errorMessage && (
            <p
              role="alert"
              data-testid="production-batch-create-error"
              className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive sm:col-span-2"
            >
              {errorMessage}
            </p>
          )}

          <div className="flex justify-end gap-2 sm:col-span-2">
            <button
              type="button"
              data-testid="production-batch-create-cancel"
              onClick={onClose}
              disabled={busy}
              className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-secondary disabled:opacity-60"
            >
              Cancel
            </button>
            <button
              type="submit"
              data-testid="production-batch-create-submit"
              disabled={busy}
              className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy ? 'Creating…' : 'Create Batch'}
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
