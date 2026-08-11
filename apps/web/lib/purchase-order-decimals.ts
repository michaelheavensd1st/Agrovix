import Decimal from 'decimal.js';

const PurchaseOrderDecimal = Decimal.clone({
  precision: 64,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -100,
  toExpPos: 100,
});

const DECIMAL_PATTERN = /^\d+(?:\.\d{1,6})?$/;
const currencyMinorUnits = new Map<string, number>();
const CURRENCY_CODE_PATTERN = /^[A-Za-z]{3}$/;
const LEGACY_METADATA_CURRENCIES = new Set(['JPY', 'KWD', 'USD']);

function runtimeSupportedCurrencies(): Set<string> | null {
  const supportedValuesOf = Intl.supportedValuesOf;
  if (typeof supportedValuesOf !== 'function') return null;
  try {
    return new Set(supportedValuesOf.call(Intl, 'currency'));
  } catch {
    return null;
  }
}

const supportedCurrencies = runtimeSupportedCurrencies();

function minorUnitsFor(currencyCode: string): number | null {
  if (!CURRENCY_CODE_PATTERN.test(currencyCode)) return null;
  const normalized = currencyCode.toUpperCase();
  const cached = currencyMinorUnits.get(normalized);
  if (cached !== undefined) return cached;
  try {
    const options = new Intl.NumberFormat('en', {
      style: 'currency',
      currency: normalized,
    }).resolvedOptions();
    const isTrusted = supportedCurrencies
      ? supportedCurrencies.has(normalized)
      : LEGACY_METADATA_CURRENCIES.has(normalized);
    const digits = options.maximumFractionDigits;
    if (
      !isTrusted ||
      options.currency !== normalized ||
      typeof digits !== 'number' ||
      !Number.isInteger(digits) ||
      digits < 0 ||
      digits > 6
    )
      return null;
    currencyMinorUnits.set(normalized, digits);
    return digits;
  } catch {
    return null;
  }
}

export function parsePurchaseOrderDecimal(value: string): Decimal {
  if (!DECIMAL_PATTERN.test(value))
    throw new Error('Enter a positive decimal with up to 6 places.');
  return new PurchaseOrderDecimal(value);
}

export function isPurchaseOrderDecimal(value: string): boolean {
  try {
    parsePurchaseOrderDecimal(value);
    return true;
  } catch {
    return false;
  }
}

export function canonicalPurchaseOrderDecimal(value: string): string {
  return parsePurchaseOrderDecimal(value).toFixed(6, Decimal.ROUND_HALF_UP);
}

export function isPositivePurchaseOrderDecimal(value: string): boolean {
  try {
    return parsePurchaseOrderDecimal(value).greaterThan(0);
  } catch {
    return false;
  }
}

export function subtractPurchaseOrderDecimals(left: string, right: string): string {
  return parsePurchaseOrderDecimal(left).minus(parsePurchaseOrderDecimal(right)).toFixed(6);
}

export function comparePurchaseOrderDecimals(left: string, right: string): number {
  return parsePurchaseOrderDecimal(left).comparedTo(parsePurchaseOrderDecimal(right));
}

export function formatPurchaseOrderDecimal(
  value: string,
  options: { minimumFractionDigits?: number; maximumFractionDigits?: number } = {},
): string {
  const decimal = parsePurchaseOrderDecimal(value);
  const maximumFractionDigits = Math.min(6, Math.max(0, options.maximumFractionDigits ?? 6));
  const minimumFractionDigits = Math.min(
    maximumFractionDigits,
    Math.max(0, options.minimumFractionDigits ?? 0),
  );
  const fixed = decimal.toFixed(maximumFractionDigits, Decimal.ROUND_HALF_UP);
  const [whole, fraction = ''] = fixed.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const trimmed = fraction.replace(/0+$/, '');
  const displayedFraction = trimmed.padEnd(minimumFractionDigits, '0');
  return displayedFraction ? `${grouped}.${displayedFraction}` : grouped;
}

export function formatPurchaseOrderMoney(value: string, currencyCode: string): string {
  const normalizedCurrency = currencyCode.trim().toUpperCase();
  const digits = minorUnitsFor(normalizedCurrency);
  if (digits === null) return normalizedCurrency ? `${normalizedCurrency} ${value}` : value;
  const amount = parsePurchaseOrderDecimal(value).toFixed(digits, Decimal.ROUND_HALF_UP);
  const [whole, fraction] = amount.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${normalizedCurrency} ${grouped}${fraction === undefined ? '' : `.${fraction}`}`;
}
