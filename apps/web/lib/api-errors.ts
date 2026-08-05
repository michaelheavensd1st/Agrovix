import { ApiError } from '@/lib/api';

export interface ParsedApiErrors {
  fieldErrors: Record<string, string>;
  generalErrors: string[];
}

interface ErrorEntry {
  field?: unknown;
  loc?: unknown;
  message?: unknown;
  msg?: unknown;
}

function mappedField(
  rawField: unknown,
  message: string,
  knownFields: ReadonlySet<string>,
): string | null {
  if (typeof rawField === 'string' && knownFields.has(rawField)) return rawField;
  let inferred: { field: string; index: number } | null = null;
  for (const field of knownFields) {
    const index = message.indexOf(field);
    if (index >= 0 && (!inferred || index < inferred.index)) inferred = { field, index };
  }
  return inferred?.field ?? null;
}

function addEntry(result: ParsedApiErrors, entry: ErrorEntry, knownFields: ReadonlySet<string>) {
  const message =
    typeof entry.message === 'string'
      ? entry.message
      : typeof entry.msg === 'string'
        ? entry.msg
        : 'Invalid value.';
  const loc = Array.isArray(entry.loc) ? entry.loc.at(-1) : entry.field;
  const field = mappedField(loc, message, knownFields);
  if (field) result.fieldErrors[field] = message;
  else result.generalErrors.push(message);
}

export function parseApiErrors(
  error: unknown,
  knownFields: ReadonlySet<string> = new Set(),
): ParsedApiErrors {
  const result: ParsedApiErrors = { fieldErrors: {}, generalErrors: [] };
  if (!(error instanceof ApiError)) {
    result.generalErrors.push(error instanceof Error ? error.message : String(error));
    return result;
  }

  const detail = (error.payload as { detail?: unknown }).detail;
  if (typeof detail === 'string') {
    result.generalErrors.push(detail);
    return result;
  }
  if (Array.isArray(detail)) {
    detail.forEach((entry) => {
      if (entry && typeof entry === 'object') addEntry(result, entry as ErrorEntry, knownFields);
    });
    return result;
  }
  if (detail && typeof detail === 'object') {
    const object = detail as {
      errors?: unknown;
      message?: unknown;
      code?: unknown;
    };
    if (Array.isArray(object.errors)) {
      object.errors.forEach((entry) => {
        if (entry && typeof entry === 'object') addEntry(result, entry as ErrorEntry, knownFields);
      });
    }
    if (typeof object.message === 'string' && result.generalErrors.length === 0) {
      result.generalErrors.push(object.message);
    } else if (typeof object.code === 'string' && result.generalErrors.length === 0) {
      result.generalErrors.push(object.code);
    }
  }
  if (Object.keys(result.fieldErrors).length === 0 && result.generalErrors.length === 0) {
    result.generalErrors.push(`Request failed (${error.status}).`);
  }
  return result;
}
