/**
 * @agrovix/utils
 * -----------------------------------------------------------------------
 * Pure, framework-free utility helpers shared across every surface.
 */

/** Assert-style check that narrows the value to non-nullable. */
export function assertDefined<T>(
  value: T | null | undefined,
  msg = 'Expected value to be defined',
): T {
  if (value === null || value === undefined) {
    throw new Error(msg);
  }
  return value;
}

/** Sleep for `ms` milliseconds (Promise-based). */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Format an ISO datetime string as a locale date. */
export function formatDate(iso: string, locale = 'en-US'): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/** Convert an unknown error into a human-readable string. */
export function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return 'Unknown error';
  }
}
