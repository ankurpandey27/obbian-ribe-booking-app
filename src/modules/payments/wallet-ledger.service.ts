import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { DRIZZLE_DB, DrizzleDB } from '../../common/database/drizzle.module';
import {
  drivers as driversTable,
  walletLedger,
} from '../../common/database/schema';
import { OutboxService } from '../../common/events/outbox.service';
import { TOPICS } from '../../shared/events/topics';
import { LedgerEventType } from '../../shared/events/contracts';
import { LEDGER_SIGN, LedgerEntryTypeValue } from '../../shared/types/common';
import { formatPaise, toRupees } from '../../shared/money';
import { MetricsService } from '../../common/observability/metrics.service';

/** Open Drizzle transaction handle. */
type Tx = Parameters<Parameters<DrizzleDB['transaction']>[0]>[0];

export interface LedgerWriteInput {
  driverId: string;
  entryType: LedgerEntryTypeValue;
  /**
   * MAGNITUDE in paise, always positive — the direction comes from
   * `entryType` via LEDGER_SIGN. The one exception is MANUAL_ADJUSTMENT,
   * which accepts a signed value because an ops correction can go either way.
   */
  amountPaise: number;
  /**
   * Caller-supplied uniqueness key. This is the crash-safety mechanism: a
   * retried worker recomputes the same key, hits the UNIQUE index, and the
   * write is recognised as already-applied instead of double-crediting.
   * Build it from stable inputs only — never Date.now() or a random id.
   */
  idempotencyKey: string;
  referenceType?: string;
  referenceId?: string;
  /** Mandatory for MANUAL_ADJUSTMENT (also enforced by a DB CHECK). */
  reason?: string;
  createdBy?: string;
}

export interface LedgerEntry {
  id: string;
  seq: number;
  driverId: string;
  entryType: string;
  amountPaise: number;
  balanceBeforePaise: number;
  balanceAfterPaise: number;
  referenceType: string | null;
  referenceId: string | null;
  reason: string | null;
  createdAt: Date;
}

export interface BalanceDrift {
  driverId: string;
  cachedBalancePaise: number;
  ledgerBalancePaise: number;
  driftPaise: number;
}

/** Postgres unique-violation. */
const PG_UNIQUE_VIOLATION = '23505';

/**
 * WalletLedgerService — the ONLY writer of driver balance.
 *
 * Before this existed, `drivers.walletBalance` was mutated by a read-then-write
 * with no history: a driver's balance had no explanation, and a payout worker
 * that crashed after crediting could credit again on retry with nothing able to
 * detect it. That is unrecoverable in a financial dispute.
 *
 * Invariants, and where each is enforced:
 *  1. Append-only. Nothing here UPDATEs or DELETEs a ledger row. Corrections
 *     are new rows (MANUAL_ADJUSTMENT with a mandatory reason).
 *  2. balanceAfter = balanceBefore + amount — DB CHECK
 *     `CHK_wallet_ledger_balance_math`. Even a bug in this file cannot write a
 *     row that fails to add up.
 *  3. Exactly-once per logical event — DB UNIQUE `idempotencyKey`.
 *  4. The cached `drivers.walletBalancePaise` is updated in the SAME
 *     transaction as the entry, so cache and truth can never diverge from a
 *     partial commit.
 *  5. Concurrent writers to one wallet serialise on `SELECT … FOR UPDATE` of
 *     the driver row, so balanceBefore is never read stale.
 *
 * The rupee column `drivers.walletBalance` is kept in step for API-contract
 * compatibility; paise is authoritative.
 */
@Injectable()
export class WalletLedgerService {
  private readonly logger = new Logger(WalletLedgerService.name);
  private readonly maxManualAdjustmentPaise: number;

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDB,
    private readonly outbox: OutboxService,
    config: ConfigService,
    @Optional() private readonly metrics?: MetricsService,
  ) {
    this.maxManualAdjustmentPaise = config.get<number>(
      'ledger.maxManualAdjustmentPaise',
      5_000_000,
    );
  }

  /**
   * Write one ledger entry and move the cached balance, atomically.
   *
   * Pass `existingTx` when the caller already owns a transaction (ride
   * completion, settlement) so the entry commits with the state change that
   * caused it. Omit it for standalone writes and this opens its own.
   */
  async write(
    input: LedgerWriteInput,
    existingTx?: Tx,
  ): Promise<LedgerEntry | null> {
    this.assertValidInput(input);

    if (existingTx) {
      return this.writeInTx(existingTx, input);
    }
    return this.db.transaction((tx) => this.writeInTx(tx, input));
  }

  /**
   * Core write. Locks the driver row first so two concurrent credits cannot
   * both read the same balanceBefore and lose one of the amounts.
   *
   * Returns `null` when the idempotency key was already used — the caller
   * should treat that as success (the effect is already applied), not as an
   * error.
   */
  private async writeInTx(
    tx: Tx,
    input: LedgerWriteInput,
  ): Promise<LedgerEntry | null> {
    const signedAmount = this.signedAmount(input);

    // FOR UPDATE: serialises concurrent writers on this one wallet.
    const [driver] = await tx
      .select({
        userId: driversTable.userId,
        walletBalancePaise: driversTable.walletBalancePaise,
      })
      .from(driversTable)
      .where(eq(driversTable.userId, input.driverId))
      .limit(1)
      .for('update');

    if (!driver) {
      throw new NotFoundException(`Driver ${input.driverId} not found`);
    }

    const balanceBeforePaise = driver.walletBalancePaise;
    const balanceAfterPaise = balanceBeforePaise + signedAmount;

    let inserted: typeof walletLedger.$inferSelect | undefined;
    try {
      [inserted] = await tx
        .insert(walletLedger)
        .values({
          driverId: input.driverId,
          entryType: input.entryType,
          amountPaise: signedAmount,
          balanceBeforePaise,
          balanceAfterPaise,
          referenceType: input.referenceType,
          referenceId: input.referenceId,
          idempotencyKey: input.idempotencyKey,
          reason: input.reason,
          createdBy: input.createdBy,
        })
        .returning();
    } catch (err) {
      if (this.isUniqueViolation(err)) {
        // Already applied by an earlier attempt. Not an error — the whole
        // point of the idempotency key.
        this.logger.log(
          `ledger entry already applied (key=${input.idempotencyKey}) — skipping`,
        );
        return null;
      }
      throw err;
    }

    // Cache moves in the same transaction as the entry.
    await tx
      .update(driversTable)
      .set({
        walletBalancePaise: balanceAfterPaise,
        walletBalance: toRupees(balanceAfterPaise),
        updatedAt: new Date(),
      })
      .where(eq(driversTable.userId, input.driverId));

    await this.outbox.write(tx, {
      topic: TOPICS.LEDGER_EVENTS,
      type: LedgerEventType.LEDGER_ENTRY_WRITTEN,
      aggregateType: 'driver_wallet',
      aggregateId: input.driverId,
      payload: {
        ledgerEntryId: inserted.id,
        driverId: input.driverId,
        entryType: input.entryType,
        amountPaise: signedAmount,
        balanceAfterPaise,
        referenceType: input.referenceType,
        referenceId: input.referenceId,
        occurredAt: new Date().toISOString(),
      },
    });
    this.metrics?.recordLedgerEntry(input.entryType);

    return this.toEntry(inserted);
  }

  /**
   * Write several entries against one wallet in a single transaction, applying
   * them in order so intermediate balances are correct.
   *
   * Used by ride completion (earning + commission) and settlement (payout
   * debit + adjustments), where the entries are one logical fact and must not
   * commit partially.
   */
  async writeMany(
    inputs: LedgerWriteInput[],
    existingTx?: Tx,
  ): Promise<Array<LedgerEntry | null>> {
    if (inputs.length === 0) return [];
    const distinctDrivers = new Set(inputs.map((i) => i.driverId));
    if (distinctDrivers.size > 1) {
      // Multi-wallet batches invite deadlocks through inconsistent lock
      // ordering. Callers settle one driver at a time.
      throw new BadRequestException(
        'writeMany accepts entries for a single driver only',
      );
    }

    const run = async (tx: Tx): Promise<Array<LedgerEntry | null>> => {
      const results: Array<LedgerEntry | null> = [];
      for (const input of inputs) {
        this.assertValidInput(input);
        // Sequential on purpose: each entry's balanceBefore is the previous
        // entry's balanceAfter.
        results.push(await this.writeInTx(tx, input));
      }
      return results;
    };

    return existingTx ? run(existingTx) : this.db.transaction(run);
  }

  /** Authoritative balance: the tail of the ledger, not the cached column. */
  async getBalancePaise(driverId: string): Promise<number> {
    const [row] = await this.db
      .select({ balance: walletLedger.balanceAfterPaise })
      .from(walletLedger)
      .where(eq(walletLedger.driverId, driverId))
      .orderBy(desc(walletLedger.seq))
      .limit(1);
    return row?.balance ?? 0;
  }

  /** Paginated statement, newest first. */
  async getStatement(
    driverId: string,
    limit = 50,
    offset = 0,
  ): Promise<LedgerEntry[]> {
    const rows = await this.db
      .select()
      .from(walletLedger)
      .where(eq(walletLedger.driverId, driverId))
      .orderBy(desc(walletLedger.seq))
      .limit(Math.min(limit, 100))
      .offset(offset);
    return rows.map((r) => this.toEntry(r));
  }

  /** Earnings total over a window — the settlement input, from the ledger. */
  async getEarningsSincePaise(driverId: string, since: Date): Promise<number> {
    const [row] = await this.db
      .select({
        total: sql<number>`COALESCE(SUM(${walletLedger.amountPaise}), 0)::int`,
      })
      .from(walletLedger)
      .where(
        and(
          eq(walletLedger.driverId, driverId),
          gte(walletLedger.createdAt, since),
        ),
      );
    return Number(row?.total ?? 0);
  }

  /**
   * Re-derive every driver's balance from the ledger and report disagreement
   * with the cached column.
   *
   * Drift is never benign: it means a write path mutated `walletBalancePaise`
   * without going through this service, so some money movement has no
   * explanation. The reconciliation job alerts on a non-empty result.
   *
   * Read-only. Repair is a deliberate ops action (`repairDrift`), because
   * silently overwriting the cache would erase the evidence.
   */
  async findBalanceDrift(limit = 500, offset = 0): Promise<BalanceDrift[]> {
    const rows = await this.db
      .select({
        driverId: driversTable.userId,
        cached: driversTable.walletBalancePaise,
        ledger: sql<number>`COALESCE((
          SELECT SUM(wl."amountPaise")::int
            FROM wallet_ledger wl
           WHERE wl."driverId" = ${driversTable.userId}
        ), 0)`,
      })
      .from(driversTable)
      .orderBy(driversTable.userId)
      .limit(limit)
      .offset(offset);

    return rows
      .map((r) => ({
        driverId: r.driverId,
        cachedBalancePaise: Number(r.cached),
        ledgerBalancePaise: Number(r.ledger),
        driftPaise: Number(r.cached) - Number(r.ledger),
      }))
      .filter((r) => r.driftPaise !== 0);
  }

  /**
   * Reset the cache to the ledger truth for one driver and emit a drift event
   * so the incident is recorded rather than quietly patched.
   *
   * Deliberately does NOT write a compensating ledger entry: the ledger was
   * right, the cache was wrong. Inventing an entry would corrupt the audit
   * trail to make a derived value look tidy.
   */
  async repairDrift(driverId: string): Promise<BalanceDrift> {
    return this.db.transaction(async (tx) => {
      const [driver] = await tx
        .select({
          cached: driversTable.walletBalancePaise,
          ledger: sql<number>`COALESCE((
            SELECT SUM(wl."amountPaise")::int
              FROM wallet_ledger wl
             WHERE wl."driverId" = ${driversTable.userId}
          ), 0)`,
        })
        .from(driversTable)
        .where(eq(driversTable.userId, driverId))
        .limit(1)
        .for('update');

      if (!driver) {
        throw new NotFoundException(`Driver ${driverId} not found`);
      }

      const cachedBalancePaise = Number(driver.cached);
      const ledgerBalancePaise = Number(driver.ledger);
      const driftPaise = cachedBalancePaise - ledgerBalancePaise;

      if (driftPaise !== 0) {
        this.metrics?.recordLedgerDrift('driver');
        await tx
          .update(driversTable)
          .set({
            walletBalancePaise: ledgerBalancePaise,
            walletBalance: toRupees(ledgerBalancePaise),
            updatedAt: new Date(),
          })
          .where(eq(driversTable.userId, driverId));

        await this.outbox.write(tx, {
          topic: TOPICS.LEDGER_EVENTS,
          type: LedgerEventType.BALANCE_DRIFT_DETECTED,
          aggregateType: 'driver_wallet',
          aggregateId: driverId,
          payload: {
            driverId,
            cachedBalancePaise,
            ledgerBalancePaise,
            driftPaise,
            detectedAt: new Date().toISOString(),
          },
        });

        this.logger.error(
          `balance drift repaired for driver=${driverId}: cache=${formatPaise(
            cachedBalancePaise,
          )} ledger=${formatPaise(ledgerBalancePaise)} drift=${formatPaise(
            driftPaise,
          )}`,
        );
      }

      return {
        driverId,
        cachedBalancePaise,
        ledgerBalancePaise,
        driftPaise,
      };
    });
  }

  /**
   * Direction and magnitude for an entry.
   *
   * Every type except MANUAL_ADJUSTMENT takes the magnitude and applies the
   * sign declared in LEDGER_SIGN, so a caller cannot accidentally turn a
   * commission debit into a credit by passing a negative number.
   * MANUAL_ADJUSTMENT is the deliberate escape hatch and keeps its sign.
   */
  private signedAmount(input: LedgerWriteInput): number {
    if (input.entryType === 'MANUAL_ADJUSTMENT') {
      return Math.round(input.amountPaise);
    }
    return (
      Math.abs(Math.round(input.amountPaise)) * LEDGER_SIGN[input.entryType]
    );
  }

  private assertValidInput(input: LedgerWriteInput): void {
    if (!Number.isFinite(input.amountPaise)) {
      throw new BadRequestException('amountPaise must be a finite number');
    }
    if (!Number.isInteger(input.amountPaise)) {
      // Rejecting rather than rounding: a fractional paise means the caller
      // did float money maths, and the right fix is upstream.
      throw new BadRequestException(
        `amountPaise must be an integer (got ${input.amountPaise}) — ` +
          'compute money in paise, never in floats',
      );
    }
    if (input.amountPaise === 0) {
      throw new BadRequestException('amountPaise must be non-zero');
    }
    if (!input.idempotencyKey || input.idempotencyKey.trim() === '') {
      throw new BadRequestException('idempotencyKey is required');
    }
    if (input.idempotencyKey.length > 160) {
      throw new BadRequestException('idempotencyKey exceeds 160 characters');
    }
    if (input.entryType === 'MANUAL_ADJUSTMENT') {
      if (!input.reason || input.reason.trim() === '') {
        throw new BadRequestException(
          'reason is required for MANUAL_ADJUSTMENT',
        );
      }
      if (Math.abs(input.amountPaise) > this.maxManualAdjustmentPaise) {
        throw new BadRequestException(
          `manual adjustment ${formatPaise(
            Math.abs(input.amountPaise),
          )} exceeds the ${formatPaise(
            this.maxManualAdjustmentPaise,
          )} single-approver ceiling`,
        );
      }
    }
  }

  /**
   * Detect a Postgres unique violation.
   *
   * Drizzle WRAPS driver errors in a DrizzleQueryError, so the pg error code
   * lives on `.cause`, not on the thrown object. Checking only the top level
   * silently misses every real violation — the idempotency guard then throws
   * instead of recognising an already-applied entry, which turns a safe retry
   * into a failed one. Walks the cause chain to be robust to wrapper depth.
   */
  private isUniqueViolation(err: unknown): boolean {
    let current: unknown = err;
    for (let depth = 0; current && depth < 5; depth += 1) {
      if ((current as { code?: string }).code === PG_UNIQUE_VIOLATION) {
        return true;
      }
      current = (current as { cause?: unknown }).cause;
    }
    return false;
  }

  private toEntry(row: typeof walletLedger.$inferSelect): LedgerEntry {
    return {
      id: row.id,
      seq: Number(row.seq),
      driverId: row.driverId,
      entryType: row.entryType,
      amountPaise: row.amountPaise,
      balanceBeforePaise: row.balanceBeforePaise,
      balanceAfterPaise: row.balanceAfterPaise,
      referenceType: row.referenceType ?? null,
      referenceId: row.referenceId ?? null,
      reason: row.reason ?? null,
      createdAt: row.createdAt,
    };
  }
}
