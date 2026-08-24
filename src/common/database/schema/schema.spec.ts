import { getTableColumns } from 'drizzle-orm';
import * as schema from './index';

/**
 * Schema integrity guard.
 *
 * Catches the "empty column name" class of bug: a Drizzle column declared
 * as numeric('', …) compiles fine but generates SQL selecting "" — and
 * unit tests mock the db, so only this structural check sees it.
 */
describe('drizzle schema integrity', () => {
  const tables = Object.entries(schema).filter(
    ([, v]) =>
      typeof v === 'object' &&
      v !== null &&
      Symbol.for('drizzle:Name') in (v as object),
  );

  it('exposes every table', () => {
    const names = tables.map(([name]) => name).sort();
    expect(names).toEqual(
      expect.arrayContaining([
        'users',
        'refreshTokens',
        'savedLocations',
        'drivers',
        'rides',
        'scheduledRides',
        'payments',
        'promos',
        'fareConfigs',
        'outboxEvents',
      ]),
    );
  });

  it.each(tables)(
    '%s: every column has a non-empty DB name',
    (_name, table) => {
      const cols = getTableColumns(
        table as never,
      ) as unknown as Record<string, { name: string }>;
      const bad = Object.entries(cols)
        .filter(([, c]) => !c.name || c.name.trim() === '')
        .map(([key]) => key);
      expect(bad).toEqual([]);
    },
  );

  it('keys match DB names for high-risk numeric columns', () => {
    for (const [tsKey, dbName] of [
      ['estimatedFare', 'estimatedFare'],
      ['totalFare', 'totalFare'],
      ['distanceKm', 'distanceKm'],
      ['promoDiscount', 'promoDiscount'],
      ['cancellationFee', 'cancellationFee'],
    ] as const) {
      expect(ridesCol(tsKey).name).toBe(dbName);
    }
    expect(getTableColumns(schema.users).rating.name).toBe('rating');
    expect(getTableColumns(schema.drivers).rating.name).toBe('rating');
    expect(getTableColumns(schema.payments).amount.name).toBe('amount');
    expect(getTableColumns(schema.fareConfigs).commissionRate.name).toBe(
      'commissionRate',
    );
  });

  function ridesCol(key: string) {
    return (getTableColumns(schema.rides) as Record<string, { name: string }>)[
      key
    ];
  }
});
