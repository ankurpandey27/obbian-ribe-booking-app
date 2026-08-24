import { PricingService } from './pricing.service';
import { FareConfig } from '../entities/fare-config.entity';

function config(overrides: Partial<FareConfig> = {}): FareConfig {
  return {
    city: 'Delhi',
    rideType: 'CABX',
    isActive: true,
    baseFare: 60,
    perKmRate: 14,
    perMinuteRate: 2,
    minimumFare: 100,
    surgeMultiplier: 1.0,
    ...overrides,
  } as FareConfig;
}

/** Minimal Drizzle chain mock: select().from().where() [await | .limit()] */
function drizzleMock(rows: unknown[]) {
  const end = Object.assign(Promise.resolve(rows), {
    limit: () => Promise.resolve(rows),
  });
  const chain = {
    from: jest.fn(() => chain),
    where: jest.fn(() => end),
  };
  return { select: jest.fn(() => chain) };
}

function buildService(): PricingService {
  const service = new PricingService({} as never, {} as never, {} as never);
  return service;
}

describe('PricingService', () => {
  describe('calculateFare', () => {
    const service = buildService();

    it('computes base + km + min, floored at minimum fare', () => {
      // 60 + (14 × 10) + (2 × 5) = 210
      expect(service.calculateFare(config(), 10, 5)).toBe(210);
    });

    it('floors to minimum fare when raw is below it', () => {
      // 60 + (14 × 1) + (2 × 1) = 76 → floor at 100
      expect(service.calculateFare(config(), 1, 1)).toBe(100);
    });

    it('applies the config surge multiplier', () => {
      const c = config({ surgeMultiplier: 1.5 });
      // (60 + 14×10 + 2×5) × 1.5 = 315
      expect(service.calculateFare(c, 10, 5)).toBe(315);
    });

    it('rounds to the nearest ₹0.50', () => {
      const c = config({ perKmRate: 14.37, perMinuteRate: 2.4 });
      // 60 + 143.7 + 12 = 215.7 → 215.5 (nearest ₹0.50)
      expect(service.calculateFare(c, 10, 5)).toBe(215.5);
    });
  });

  describe('quote options', () => {
    it('sorts options by base fare ascending', async () => {
      const db = drizzleMock([
        config({ rideType: 'CABXL', baseFare: 90 }),
        config({ rideType: 'CABX', baseFare: 60 }),
        config({ rideType: 'AUTO', baseFare: 40 }),
      ]);
      const maps = {
        getRoute: jest.fn().mockResolvedValue({
          distanceKm: 10,
          durationMin: 15,
          polyline: 'abc',
        }),
      };
      const surge = {
        getMultiplier: jest.fn().mockResolvedValue(1.0),
      };
      const service = new PricingService(
        db as never,
        maps as never,
        surge as never,
      );

      const quote = await service.getQuote(28.7, 77.1, 28.5, 77.3, 'Delhi');

      expect(quote.options.map((o) => o.rideType)).toEqual([
        'AUTO',
        'CABX',
        'CABXL',
      ]);
      expect(quote.options[0]).toMatchObject({
        etaMinutes: expect.any(Number),
        surgeMultiplier: 1,
      });
      expect(quote.options.every((o) => o.fare > 0)).toBe(true);
      expect(quote.polyline).toBe('abc');
    });

    it('applies dynamic surge to every option and records it', async () => {
      const db = drizzleMock([config({})]);
      const maps = {
        getRoute: jest.fn().mockResolvedValue({
          distanceKm: 10,
          durationMin: 15,
          polyline: 'abc',
        }),
      };
      const surge = {
        getMultiplier: jest.fn().mockResolvedValue(1.5),
      };
      const service = new PricingService(
        db as never,
        maps as never,
        surge as never,
      );

      const quote = await service.getQuote(28.7, 77.1, 28.5, 77.3, 'Delhi');

      // 60 + 140 + 30 = 230 → ×1.5 = 345, nearest ₹0.50
      expect(quote.options[0].fare).toBe(345);
      expect(quote.options[0].surgeMultiplier).toBe(1.5);
      expect(quote.surgeMultiplier).toBe(1.5);
    });

    it('throws when no fare config exists for the city', async () => {
      const db = drizzleMock([]);
      const maps = {
        getRoute: jest.fn().mockResolvedValue({
          distanceKm: 10,
          durationMin: 15,
        }),
      };
      const surge = { getMultiplier: jest.fn().mockResolvedValue(1.0) };
      const service = new PricingService(
        db as never,
        maps as never,
        surge as never,
      );

      await expect(
        service.getQuote(28.7, 77.1, 28.5, 77.3, 'Mumbai'),
      ).rejects.toThrow('No fare config for city: Mumbai');
    });
  });
});
