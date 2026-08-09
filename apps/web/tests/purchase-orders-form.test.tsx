import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return { ...actual, apiFetch: vi.fn() };
});

import { ApiError, apiFetch } from '@/lib/api';
import {
  PurchaseOrderForm,
  buildCreatePurchaseOrderBody,
  buildUpdatePurchaseOrderBody,
  mapPurchaseOrderFormError,
  newPurchaseOrderLine,
  purchaseOrderFormValues,
  validatePurchaseOrderForm,
} from '@/components/purchase-orders/PurchaseOrderForm';
import { PurchaseOrderConflictPanel } from '@/components/purchase-orders/PurchaseOrderConflictPanel';
import type { PurchaseOrder } from '@/lib/purchase-orders';

const mockedApiFetch = vi.mocked(apiFetch);

function po(overrides: Partial<PurchaseOrder> = {}): PurchaseOrder {
  return {
    id: 'po-1',
    organization_id: 'org-1',
    farm_id: 'farm-1',
    business_partner_id: 'bp-1',
    po_number: 'PO-1',
    supplier_reference: 'REF',
    status: 'DRAFT',
    currency_code: 'USD',
    order_date: '2026-08-01',
    expected_delivery_date: '2026-08-10',
    delivery_address: {
      line1: 'Road',
      line2: null,
      city: null,
      region: null,
      postal_code: null,
      country_code: 'GH',
    },
    notes: 'Original',
    supplier_code: 'SUP',
    supplier_legal_name: 'Supplier',
    supplier_trading_name: null,
    version: 4,
    created_by_id: 'u1',
    submitted_by_id: null,
    submitted_at: null,
    approved_by_id: null,
    approved_at: null,
    rejected_by_id: null,
    rejected_at: null,
    cancelled_by_id: null,
    cancelled_at: null,
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
    subtotal: '2.000000',
    lines: [line('line-1', 'item-1'), line('line-2', 'item-2')],
    ...overrides,
  };
}
function line(id: string, item: string) {
  return {
    id,
    line_number: id === 'line-1' ? 1 : 2,
    inventory_item_id: item,
    item_code: item,
    item_name: item,
    item_sku: null,
    description: item,
    line_note: null,
    ordered_quantity: '1.000000',
    ordered_unit: 'kg',
    canonical_unit: 'kg',
    ordered_quantity_canonical: '1.000000',
    received_quantity: '0.000000',
    received_quantity_canonical: '0.000000',
    unit_price: '1.000000',
    extended_amount: '1.000000',
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
  } as const;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  mockedApiFetch.mockReset();
  mockedApiFetch.mockImplementation((path: string) => {
    if (path.includes('/farms'))
      return Promise.resolve([
        {
          id: 'farm-1',
          organization_id: 'org-1',
          code: 'F1',
          name: 'Farm',
          deleted_at: null,
          is_active: true,
        },
      ] as never);
    if (path.includes('/business-partners'))
      return Promise.resolve({
        items: [
          {
            id: 'bp-1',
            code: 'SUP',
            legal_name: 'Supplier',
            trading_name: null,
            supplier_profile: { qualification_status: 'unqualified' },
          },
        ],
        next_cursor: null,
      } as never);
    if (path.includes('/inventory-items'))
      return Promise.resolve([
        {
          id: 'item-1',
          organization_id: 'org-1',
          code: 'I1',
          name: 'Item 1',
          sku: null,
          category: 'feed',
          canonical_unit: 'kg',
          description: null,
          is_active: true,
          metadata_json: null,
          deleted_at: null,
          created_at: '',
          updated_at: '',
        },
        {
          id: 'item-2',
          organization_id: 'org-1',
          code: 'I2',
          name: 'Item 2',
          sku: 'SKU2',
          category: 'feed',
          canonical_unit: 'kg',
          description: null,
          is_active: true,
          metadata_json: null,
          deleted_at: null,
          created_at: '',
          updated_at: '',
        },
      ] as never);
    return Promise.resolve([] as never);
  });
});

describe('PurchaseOrderForm semantics', () => {
  it('builds create payloads with exact maximum Decimal strings and no client IDs', () => {
    const values = purchaseOrderFormValues();
    values.businessPartnerId = 'bp-1';
    values.orderDate = '2026-08-01';
    values.lines = [
      {
        ...newPurchaseOrderLine(),
        inventoryItemId: 'item-1',
        orderedQuantity: '999999999999.999999',
        orderedUnit: 'kg',
        unitPrice: '99999999999999.999999',
      },
    ];
    const body = buildCreatePurchaseOrderBody(values);
    expect(body.lines?.[0]).toMatchObject({
      ordered_quantity: '999999999999.999999',
      unit_price: '99999999999999.999999',
    });
    expect(body.lines?.[0]).not.toHaveProperty('id');
  });

  it('builds a minimal version-aware header patch and explicit nullable clears', () => {
    const initial = po();
    const values = purchaseOrderFormValues(initial);
    values.notes = '';
    values.supplierReference = '';
    values.expectedDeliveryDate = '';
    expect(buildUpdatePurchaseOrderBody(initial, values)).toEqual({
      expected_version: 4,
      expected_delivery_date: null,
      supplier_reference: null,
      notes: null,
    });
  });

  it('returns only expected_version for a no-op edit', () => {
    const initial = po();
    expect(buildUpdatePurchaseOrderBody(initial, purchaseOrderFormValues(initial))).toEqual({
      expected_version: 4,
    });
  });

  it('preserves survivor UUIDs, omits new IDs, and represents deletion by omission', () => {
    const initial = po();
    const values = purchaseOrderFormValues(initial);
    values.lines = [
      values.lines[1],
      {
        ...newPurchaseOrderLine(),
        inventoryItemId: 'item-1',
        orderedQuantity: '2.000000',
        orderedUnit: 'kg',
        unitPrice: '3.000000',
      },
    ];
    const body = buildUpdatePurchaseOrderBody(initial, values);
    expect(body.lines?.[0].id).toBe('line-2');
    expect(body.lines?.[1]).not.toHaveProperty('id');
    expect(body.lines?.some((candidate) => candidate.id === 'line-1')).toBe(false);
  });

  it('validates syntax, bounds, zero-price notes, dates, and currency without Number conversion', () => {
    const values = purchaseOrderFormValues();
    values.businessPartnerId = 'bp';
    values.orderDate = '2026-08-10';
    values.expectedDeliveryDate = '2026-08-01';
    values.currencyCode = 'US';
    values.lines = [
      {
        ...newPurchaseOrderLine(),
        inventoryItemId: 'item',
        orderedQuantity: '1e3',
        unitPrice: '0.000000',
        orderedUnit: 'kg',
      },
    ];
    const errors = validatePurchaseOrderForm(values);
    expect(errors.currency_code).toBeTruthy();
    expect(errors.expected_delivery_date).toBeTruthy();
    expect(errors['lines.0.ordered_quantity']).toBeTruthy();
    expect(errors['lines.0.line_note']).toBeTruthy();
  });

  it('disables no-op edit save and exposes qualification state honestly', async () => {
    render(
      <PurchaseOrderForm
        mode="edit"
        organizationId="org-1"
        initial={po()}
        submitting={false}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('po-form-submit')).toBeDisabled());
    expect(await screen.findByText(/Unqualified/)).toBeInTheDocument();
  });

  it('supports keyboard-operable add/remove without re-keying persisted rows', async () => {
    render(
      <PurchaseOrderForm
        mode="edit"
        organizationId="org-1"
        initial={po()}
        submitting={false}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('po-line-persisted-line-1')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('Remove line 1'));
    expect(screen.getByTestId('po-line-persisted-line-2')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('po-line-add'));
    expect(screen.getByTestId('po-line-persisted-line-2')).toBeInTheDocument();
  });

  it('synchronously hides org A selector data and rejects its late response under org B', async () => {
    const lateFarmA = deferred<unknown[]>();
    mockedApiFetch.mockImplementation((path: string) => {
      if (path === '/v1/organizations/org-1/farms') return lateFarmA.promise as never;
      if (path === '/v1/organizations/org-2/farms')
        return Promise.resolve([
          { id: 'farm-b', organization_id: 'org-2', code: 'FB', name: 'Farm B', is_active: true },
        ] as never);
      if (path.includes('/business-partners'))
        return Promise.resolve({ items: [], next_cursor: null } as never);
      if (path.includes('/inventory-items')) return Promise.resolve([] as never);
      return Promise.resolve([] as never);
    });
    const props = {
      mode: 'create' as const,
      submitting: false,
      onSubmit: vi.fn(),
      onCancel: vi.fn(),
    };
    const view = render(<PurchaseOrderForm {...props} organizationId="org-1" />);
    view.rerender(<PurchaseOrderForm {...props} organizationId="org-2" />);
    expect(screen.queryByRole('option', { name: /Farm A/ })).not.toBeInTheDocument();
    expect(await screen.findByRole('option', { name: /Farm B/ })).toBeInTheDocument();
    lateFarmA.resolve([
      { id: 'farm-a', organization_id: 'org-1', code: 'FA', name: 'Farm A', is_active: true },
    ]);
    await waitFor(() =>
      expect(screen.queryByRole('option', { name: /Farm A/ })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('option', { name: /Farm B/ })).toBeInTheDocument();
  });

  it('renders an accessible conflict panel with both explicit choices', () => {
    render(
      <PurchaseOrderConflictPanel
        originalVersion={4}
        latest={po({ version: 5 })}
        onReviewLatest={vi.fn()}
        onDiscard={vi.fn()}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('version 4');
    expect(screen.getByRole('button', { name: 'Review latest' })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Discard local edits/ })).toBeEnabled();
  });

  it('maps an unsupported domain currency to the rendered currency control and focuses it', async () => {
    const mapped = mapPurchaseOrderFormError(
      domainError('invalid_currency', 'currency_code is not an official ISO 4217 code.', {}),
    );
    const props = {
      mode: 'create' as const,
      organizationId: 'org-1',
      submitting: false,
      onSubmit: vi.fn(),
      onCancel: vi.fn(),
    };
    const view = render(<PurchaseOrderForm {...props} />);
    await waitFor(() => expect(screen.getByTestId('po-form-submit')).toBeEnabled());
    view.rerender(
      <PurchaseOrderForm {...props} externalErrors={mapped.fields} generalError={mapped.message} />,
    );
    const currency = screen.getByTestId('po-form-currency');
    await waitFor(() => expect(currency).toHaveFocus());
    expect(currency).toHaveAttribute('aria-invalid', 'true');
    expect(currency).toHaveAccessibleDescription(/official ISO 4217/);
    expect(screen.queryByText(/"code"|"context"/)).not.toBeInTheDocument();
  });

  it('maps invalid country and delivery line1 domain contexts to edit address controls', async () => {
    const props = {
      mode: 'edit' as const,
      organizationId: 'org-1',
      initial: po(),
      submitting: false,
      onSubmit: vi.fn(),
      onCancel: vi.fn(),
    };
    const view = render(<PurchaseOrderForm {...props} />);
    await waitFor(() => expect(screen.getByTestId('po-form-submit')).toBeDisabled());
    const country = mapPurchaseOrderFormError(
      domainError('invalid_country_code', 'The delivery country is invalid.', {
        country_code: 'ZZ',
      }),
    );
    view.rerender(
      <PurchaseOrderForm
        {...props}
        externalErrors={country.fields}
        generalError={country.message}
      />,
    );
    const countryInput = screen.getByTestId('po-form-address-countryCode');
    await waitFor(() => expect(countryInput).toHaveFocus());
    expect(countryInput).toHaveAttribute('aria-invalid', 'true');
    expect(countryInput).toHaveAccessibleDescription(/country is invalid/);

    const line1 = mapPurchaseOrderFormError(
      domainError('invalid_delivery_address', 'delivery_address.line1 is invalid.', {
        field: 'line1',
      }),
    );
    view.rerender(
      <PurchaseOrderForm {...props} externalErrors={line1.fields} generalError={line1.message} />,
    );
    const line1Input = screen.getByTestId('po-form-address-line1');
    await waitFor(() => expect(line1Input).toHaveFocus());
    expect(line1Input).toHaveAttribute('aria-invalid', 'true');
    expect(line1Input).toHaveAccessibleDescription(/line1 is invalid/);
  });

  it('preserves indexed Pydantic line mapping and leaves ambiguous fields summary-only', async () => {
    const indexed = mapPurchaseOrderFormError(
      new ApiError(422, {
        detail: [
          { loc: ['body', 'lines', 0, 'unit_price'], msg: 'Enter a legal price.' },
        ] as unknown as string,
      }),
    );
    const props = {
      mode: 'edit' as const,
      organizationId: 'org-1',
      initial: po(),
      submitting: false,
      onSubmit: vi.fn(),
      onCancel: vi.fn(),
    };
    const view = render(<PurchaseOrderForm {...props} />);
    await waitFor(() => expect(screen.getByTestId('po-line-0-price')).toBeEnabled());
    view.rerender(
      <PurchaseOrderForm
        {...props}
        externalErrors={indexed.fields}
        generalError={indexed.message}
      />,
    );
    const price = screen.getByTestId('po-line-0-price');
    await waitFor(() => expect(price).toHaveFocus());
    expect(price).toHaveAccessibleDescription('Enter a legal price.');

    const ambiguous = mapPurchaseOrderFormError(
      domainError('unknown_rule', 'Review the supplied Draft.', { field: 'mystery' }),
    );
    expect(ambiguous.fields).toEqual({});
    view.rerender(
      <PurchaseOrderForm
        {...props}
        externalErrors={ambiguous.fields}
        generalError={ambiguous.message}
      />,
    );
    await waitFor(() => expect(screen.getByRole('alert')).toHaveFocus());
    expect(screen.getByText('Review the supplied Draft.')).toBeInTheDocument();
    expect(screen.queryByText(/"mystery"/)).not.toBeInTheDocument();
  });
});

function domainError(code: string, message: string, context: Record<string, unknown>): ApiError {
  return new ApiError(422, {
    detail: { code, message, context } as unknown as string,
  });
}
