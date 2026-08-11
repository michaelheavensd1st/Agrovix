import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  comparePurchaseOrderDecimals,
  canonicalPurchaseOrderDecimal,
  formatPurchaseOrderDecimal,
  formatPurchaseOrderMoney,
  isPositivePurchaseOrderDecimal,
  isPurchaseOrderDecimal,
  parsePurchaseOrderDecimal,
  subtractPurchaseOrderDecimals,
} from '@/lib/purchase-order-decimals';

describe('Purchase Order Decimal helpers', () => {
  afterEach(() => {
    vi.resetModules();
  });
  it('preserves maximum legal values without binary-float drift', () => {
    const quantity = parsePurchaseOrderDecimal('999999999999.999999');
    const price = parsePurchaseOrderDecimal('99999999999999.999999');
    expect(quantity.times(price).toFixed(6)).toBe('99999999999999999899000000.000000');
  });

  it('preserves six-place canonical strings and trailing zeros', () => {
    expect(canonicalPurchaseOrderDecimal('12.340000')).toBe('12.340000');
    expect(canonicalPurchaseOrderDecimal('0')).toBe('0.000000');
  });

  it('formats normal values without scientific notation', () => {
    expect(formatPurchaseOrderDecimal('999999999999.999999')).toBe('999,999,999,999.999999');
    expect(formatPurchaseOrderMoney('123456789.995000', 'USD')).toBe('USD 123,456,790.00');
    expect(formatPurchaseOrderMoney('0.005000', 'USD')).toBe('USD 0.01');
  });

  it('uses ISO currency minor units without converting through Number', () => {
    expect(formatPurchaseOrderMoney('1.600000', 'JPY')).toBe('JPY 2');
    expect(formatPurchaseOrderMoney('1.234567', 'KWD')).toBe('KWD 1.235');
    expect(formatPurchaseOrderMoney('1.235000', 'USD')).toBe('USD 1.24');
    expect(formatPurchaseOrderMoney('0.000000', 'JPY')).toBe('JPY 0');
    expect(formatPurchaseOrderMoney('12.340000', 'USD')).toBe('USD 12.34');
    expect(formatPurchaseOrderMoney('99999999999999.999999', 'KWD')).toBe(
      'KWD 100,000,000,000,000.000',
    );
  });

  it('safely preserves canonical decimals for malformed and unknown currencies', () => {
    for (const currency of ['US', 'INVALID', '', 'ZZZ']) {
      expect(() => formatPurchaseOrderMoney('1.234567', currency)).not.toThrow();
    }
    expect(formatPurchaseOrderMoney('1.234567', 'US')).toBe('US 1.234567');
    expect(formatPurchaseOrderMoney('1.234567', 'INVALID')).toBe('INVALID 1.234567');
    expect(formatPurchaseOrderMoney('1.234567', '')).toBe('1.234567');
    expect(formatPurchaseOrderMoney('1.234567', 'ZZZ')).toBe('ZZZ 1.234567');
  });

  it('rejects invalid syntax and more than six decimal places', () => {
    expect(isPurchaseOrderDecimal('1.123456')).toBe(true);
    expect(isPurchaseOrderDecimal('1.1234567')).toBe(false);
    expect(isPurchaseOrderDecimal('1e3')).toBe(false);
    expect(() => parsePurchaseOrderDecimal('NaN')).toThrow();
  });

  it('computes receipt remaining quantities without binary floating point', () => {
    expect(subtractPurchaseOrderDecimals('999999999999.999999', '0.000001')).toBe(
      '999999999999.999998',
    );
    expect(comparePurchaseOrderDecimals('0.100000', '0.099999')).toBe(1);
    expect(isPositivePurchaseOrderDecimal('0.000001')).toBe(true);
    expect(isPositivePurchaseOrderDecimal('0.000000')).toBe(false);
  });

  it('loads safely when Intl.supportedValuesOf is unavailable', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(Intl, 'supportedValuesOf');
    Object.defineProperty(Intl, 'supportedValuesOf', {
      configurable: true,
      value: undefined,
    });
    vi.resetModules();
    try {
      const legacyHelper = await import('@/lib/purchase-order-decimals');
      expect(legacyHelper.formatPurchaseOrderMoney('1.600000', 'JPY')).toBe('JPY 2');
      expect(legacyHelper.formatPurchaseOrderMoney('1.235000', 'USD')).toBe('USD 1.24');
      expect(legacyHelper.formatPurchaseOrderMoney('1.234567', 'KWD')).toBe('KWD 1.235');
      expect(legacyHelper.formatPurchaseOrderMoney('1.234567', 'US')).toBe('US 1.234567');
      expect(legacyHelper.formatPurchaseOrderMoney('1.234567', 'ZZZ')).toBe('ZZZ 1.234567');
    } finally {
      if (descriptor) Object.defineProperty(Intl, 'supportedValuesOf', descriptor);
      else delete (Intl as { supportedValuesOf?: unknown }).supportedValuesOf;
    }
  });
});
