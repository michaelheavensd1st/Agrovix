/**
 * Vitest guard for the deliberate operational event forms.
 *
 * These are minimal render + form-validation checks — the full E2E
 * happens against a live FastAPI in the pytest suite. Here we
 * verify the client-side gates that stop empty / unconfirmed
 * submissions ever leaving the browser.
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { StockingForm, MortalityForm } from '@/components/event-forms';

describe('StockingForm', () => {
  it('renders required inputs and confirmation checkbox', () => {
    render(<StockingForm batchId="b1" onCreated={() => {}} onCancel={() => {}} />);
    expect(screen.getByTestId('stocking-species')).toBeInTheDocument();
    expect(screen.getByTestId('stocking-quantity')).toBeInTheDocument();
    expect(screen.getByTestId('stocking-avg-weight')).toBeInTheDocument();
    expect(screen.getByTestId('stocking-confirm')).toBeInTheDocument();
    expect(screen.getByTestId('stocking-submit')).toBeInTheDocument();
  });

  it('blocks submission until the confirmation checkbox is checked', async () => {
    const onCreated = vi.fn();
    render(<StockingForm batchId="b1" onCreated={onCreated} onCancel={() => {}} />);
    fireEvent.click(screen.getByTestId('stocking-submit'));
    await waitFor(() => {
      expect(screen.getByTestId('stocking-error')).toHaveTextContent(/confirm/i);
    });
    expect(onCreated).not.toHaveBeenCalled();
  });
});

describe('MortalityForm', () => {
  it('renders the population-guard warning and the confirm checkbox', () => {
    render(<MortalityForm batchId="b1" onCreated={() => {}} onCancel={() => {}} />);
    expect(screen.getByTestId('mortality-count')).toBeInTheDocument();
    expect(screen.getByTestId('mortality-confirm')).toBeInTheDocument();
    expect(screen.getByText(/exceeds population/i)).toBeInTheDocument();
  });

  it('refuses submit until confirmed', async () => {
    render(<MortalityForm batchId="b1" onCreated={() => {}} onCancel={() => {}} />);
    fireEvent.click(screen.getByTestId('mortality-submit'));
    await waitFor(() => {
      expect(screen.getByTestId('mortality-error')).toBeInTheDocument();
    });
  });
});
