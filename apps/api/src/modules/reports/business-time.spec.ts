import { describe, expect, it } from 'vitest';

import {
  BUSINESS_TIMEZONE,
  todayInBusinessZone,
  zoneOffsetMs,
  zonedDayEndExclusiveUtc,
  zonedDayStartUtc,
} from './business-time';

/**
 * 夏令时边界是报表最容易出错的地方：Melbourne 在 10 月第一个周日 +11，
 * 4 月第一个周日回 +10。下面的期望值全部按真实时区规则给出（不是手算偏移表）。
 */
describe('business timezone helpers', () => {
  it('uses the confirmed business timezone', () => {
    expect(BUSINESS_TIMEZONE).toBe('Australia/Melbourne');
  });

  it('converts a summer day start to UTC (AEDT, +11)', () => {
    expect(zonedDayStartUtc('2026-11-06').toISOString()).toBe('2026-11-05T13:00:00.000Z');
  });

  it('converts a winter day start to UTC (AEST, +10)', () => {
    expect(zonedDayStartUtc('2026-06-15').toISOString()).toBe('2026-06-14T14:00:00.000Z');
  });

  it('handles the DST start day (2026-10-04) where the local day is 23 hours long', () => {
    expect(zonedDayStartUtc('2026-10-04').toISOString()).toBe('2026-10-03T14:00:00.000Z');
    expect(zonedDayEndExclusiveUtc('2026-10-04').toISOString()).toBe('2026-10-04T13:00:00.000Z');
    const lengthHours =
      (zonedDayEndExclusiveUtc('2026-10-04').getTime() - zonedDayStartUtc('2026-10-04').getTime()) /
      3_600_000;
    expect(lengthHours).toBe(23);
  });

  it('handles the DST end day (2027-04-04) where the local day is 25 hours long', () => {
    const lengthHours =
      (zonedDayEndExclusiveUtc('2027-04-04').getTime() - zonedDayStartUtc('2027-04-04').getTime()) /
      3_600_000;
    expect(lengthHours).toBe(25);
  });

  it('keeps ordinary days at exactly 24 hours', () => {
    const lengthHours =
      (zonedDayEndExclusiveUtc('2026-11-06').getTime() - zonedDayStartUtc('2026-11-06').getTime()) /
      3_600_000;
    expect(lengthHours).toBe(24);
  });

  it('reports the zone offset for both seasons', () => {
    expect(zoneOffsetMs(new Date('2026-11-06T00:00:00.000Z'))).toBe(11 * 3_600_000);
    expect(zoneOffsetMs(new Date('2026-06-15T00:00:00.000Z'))).toBe(10 * 3_600_000);
  });

  it('names the business day for a UTC instant near midnight', () => {
    // 2026-11-05T13:30Z 在 Melbourne 已经是 11-06 00:30。
    expect(todayInBusinessZone(new Date('2026-11-05T13:30:00.000Z'))).toBe('2026-11-06');
    // 2026-11-05T12:30Z 仍是 11-05 23:30。
    expect(todayInBusinessZone(new Date('2026-11-05T12:30:00.000Z'))).toBe('2026-11-05');
  });

  it('rejects a malformed local date', () => {
    expect(() => zonedDayStartUtc('2026-11-6')).toThrow(/invalid local date/);
  });
});
