import { BadRequestException } from '@nestjs/common';

/**
 * 业务时区（D-051：Australia/Melbourne）。
 *
 * 数据库统一存 UTC；报表按业务时区切分自然日。这里只做"本地日 → UTC 瞬时"的换算，
 * 用两次逼近处理夏令时（AEDT +11 / AEST +10），避免手写偏移表。
 */

/**
 * 正则通过但日历上不存在的日期（2026-13-01、2026-02-31）必须拒绝：
 * Date.UTC 会把它们静默滚动到别的月份。
 */
export function assertCalendarDate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new BadRequestException('日期格式必须为 YYYY-MM-DD');
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new BadRequestException('日期不存在');
  }
}

export const BUSINESS_TIMEZONE = 'Australia/Melbourne';

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  formatterCache.set(timeZone, formatter);
  return formatter;
}

/** 指定时区在该瞬时相对 UTC 的偏移（毫秒，东区为正）。 */
export function zoneOffsetMs(instant: Date, timeZone = BUSINESS_TIMEZONE): number {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const lookup = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');
  const asUtc = Date.UTC(
    lookup('year'),
    lookup('month') - 1,
    lookup('day'),
    lookup('hour') === 24 ? 0 : lookup('hour'),
    lookup('minute'),
    lookup('second'),
  );
  return asUtc - instant.getTime();
}

/** 把业务时区的某个本地自然日 00:00 换算成 UTC 瞬时。 */
export function zonedDayStartUtc(localDate: string, timeZone = BUSINESS_TIMEZONE): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  if (!match) throw new Error(`invalid local date: ${localDate}`);
  const [, y, m, d] = match;
  const naive = Date.UTC(Number(y), Number(m) - 1, Number(d), 0, 0, 0);
  // 第一遍用该瞬时自身的偏移做估计，第二遍用估计值再校正一次（覆盖夏令时切换日）。
  const firstGuess = new Date(naive - zoneOffsetMs(new Date(naive), timeZone));
  return new Date(naive - zoneOffsetMs(firstGuess, timeZone));
}

/** 业务时区自然日区间的半开上界（次日 00:00）。 */
export function zonedDayEndExclusiveUtc(localDate: string, timeZone = BUSINESS_TIMEZONE): Date {
  // 直接算"本地日 +1 的 00:00"，夏令时切换日自然得到 23h/25h 的长度。
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  if (!match) throw new Error(`invalid local date: ${localDate}`);
  const [, y, m, d] = match;
  const nextDay = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d) + 1));
  return zonedDayStartUtc(nextDay.toISOString().slice(0, 10), timeZone);
}

/** 业务时区下"今天"的日期字符串（YYYY-MM-DD）。 */
export function todayInBusinessZone(now: Date = new Date(), timeZone = BUSINESS_TIMEZONE): string {
  const parts = formatterFor(timeZone).formatToParts(now);
  const lookup = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '00';
  return `${lookup('year')}-${lookup('month')}-${lookup('day')}`;
}
