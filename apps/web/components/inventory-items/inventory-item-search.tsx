import { useEffect, useRef, useState } from 'react';
import { makeDebouncer } from '@/lib/inventory-items';

/**
 * Sprint 5.3 — debounced item search. The parent owns the emitted
 * value; the raw value stays local so typing feels responsive.
 * Timer lifetime is bounded to the component's mount — the
 * cleanup function cancels any pending fire so we do not leak
 * writes after unmount.
 */
export function InventoryItemSearch({
  onDebouncedChange,
  debounceMs = 200,
  placeholder = 'Search by name, code, SKU or description…',
}: {
  onDebouncedChange: (value: string) => void;
  debounceMs?: number;
  placeholder?: string;
}) {
  const [raw, setRaw] = useState('');
  const onRef = useRef(onDebouncedChange);
  useEffect(() => {
    onRef.current = onDebouncedChange;
  }, [onDebouncedChange]);

  useEffect(() => {
    const d = makeDebouncer((v: string) => onRef.current(v), debounceMs);
    d.trigger(raw);
    return () => d.cancel();
  }, [raw, debounceMs]);

  return (
    <input
      type="search"
      data-testid="item-search"
      value={raw}
      onChange={(e) => setRaw(e.target.value)}
      placeholder={placeholder}
      className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm"
    />
  );
}
