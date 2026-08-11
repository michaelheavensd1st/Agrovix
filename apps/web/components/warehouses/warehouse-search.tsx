import { useEffect, useRef, useState } from 'react';
import { debounce } from '@/lib/inventory-warehouses';

/**
 * Sprint 5.2 — debounced warehouse search input. The debounced
 * value flows out via `onDebouncedChange`; the raw value stays
 * local so keystrokes feel responsive.
 *
 * The parent owns the search string and injects a debounce
 * lifetime so tests can pin a value if they need to.
 */
export function WarehouseSearch({
  onDebouncedChange,
  debounceMs = 200,
  placeholder = 'Search by name, code, or description…',
  testId = 'warehouse-search',
}: {
  onDebouncedChange: (value: string) => void;
  debounceMs?: number;
  placeholder?: string;
  testId?: string;
}) {
  const [raw, setRaw] = useState('');
  const callbackRef = useRef(onDebouncedChange);
  useEffect(() => {
    callbackRef.current = onDebouncedChange;
  }, [onDebouncedChange]);

  useEffect(() => {
    const emit = debounce((v: string) => callbackRef.current(v), debounceMs);
    emit(raw);
    return () => emit.cancel();
  }, [raw, debounceMs]);
  return (
    <input
      type="search"
      data-testid={testId}
      value={raw}
      onChange={(e) => setRaw(e.target.value)}
      placeholder={placeholder}
      className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm"
    />
  );
}
