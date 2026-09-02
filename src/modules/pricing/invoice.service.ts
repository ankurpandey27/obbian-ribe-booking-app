import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE_DB, DrizzleDB } from '../../common/database/drizzle.module';
import { invoiceSequences, invoices } from '../../common/database/schema';
import { extractInclusiveTax } from '../../shared/money';
import { stateCodeForCity } from '../../shared/cities';

/** Open Drizzle transaction handle. */
type Tx = Parameters<Parameters<DrizzleDB['transaction']>[0]>[0];

const PG_UNIQUE_VIOLATION = '23505';

export interface IssueInvoiceInput {
  rideId: string;
  /** Gross, tax-INCLUSIVE amount the rider paid, in paise. */
  grossPaise: number;
  /**
   * Service city (e.g. "Hyderabad"). Resolved to a GST STATE CODE before the
   * intra/inter-state decision — callers pass the city they already have and
   * this service owns the mapping.
   */
  city?: string;
  /**
   * Explicit GST state code, when the caller already knows it. Overrides `city`.
   */
  placeOfSupplyStateCode?: string;
  /** Supplied by B2B riders who want input tax credit. */
  buyerGstin?: string;
  buyerLegalName?: string;
}

export interface InvoiceRecord {
  id: string;
  rideId: string;
  invoiceNumber: string;
  financialYear: string;
  status: string;
  taxableValuePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  totalPaise: number;
  gstRatePercent: number;
  sacCode: string;
  buyerGstin?: string;
  placeOfSupply?: string;
  issuedAt?: string;
}

/**
 * InvoiceService — GST invoices for completed rides (Indian legal requirement).
 *
 * Three things make this non-trivial, and each is handled explicitly:
 *
 *  1. NUMBERING MUST BE GAP-FREE per financial year. A missing number in a
 *     sequence is an audit finding. A Postgres SEQUENCE is the wrong tool
 *     because it does not roll back — a failed transaction burns a number
 *     permanently. Instead `invoice_sequences` holds a counter row that the
 *     issuer takes `FOR UPDATE` on: concurrent issuance serialises, and a
 *     rollback returns the number to the pool.
 *
 *  2. FARES ARE QUOTED TAX-INCLUSIVE. The rider agreed to ₹400 total, not
 *     ₹400 + GST. So the taxable value is derived backwards
 *     (gross × 100 / (100 + rate)) and the tax is the remainder, guaranteeing
 *     taxable + tax === gross exactly. Computing tax forwards from the gross
 *     would over-collect and break the DB CHECK.
 *
 *  3. INTRA-STATE vs INTER-STATE. Same-state supply is CGST + SGST (half each);
 *     cross-state is IGST. Never both — enforced by `CHK_invoices_gst_split`.
 *
 * Issued invoices are immutable. A correction is a cancellation plus a fresh
 * invoice, never an edit.
 */
@Injectable()
export class InvoiceService {
  private readonly logger = new Logger(InvoiceService.name);
  private readonly enabled: boolean;
  private readonly gstRatePercent: number;
  private readonly sacCode: string;
  private readonly series: string;
  private readonly sellerGstin?: string;
  private readonly sellerLegalName?: string;
  private readonly sellerStateCode: string;

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDB,
    config: ConfigService,
  ) {
    this.enabled = config.get<boolean>('invoice.enabled', true);
    this.gstRatePercent = config.get<number>('invoice.gstRatePercent', 5);
    this.sacCode = config.get<string>('invoice.sacCode', '996422');
    this.series = config.get<string>('invoice.series', 'OBN');
    this.sellerGstin = config.get<string>('invoice.sellerGstin');
    this.sellerLegalName = config.get<string>('invoice.sellerLegalName');
    this.sellerStateCode = config.get<string>('invoice.sellerStateCode', 'TS');
  }

  /**
   * Issue the invoice for a ride.
   *
   * Idempotent: `invoices.rideId` is UNIQUE, so a retried completion returns
   * the existing invoice instead of minting a second number for the same ride.
   * That matters — duplicate invoices for one supply are worse than none.
   *
   * Accepts the caller's transaction so the invoice commits with the ride
   * completion that produced it.
   */
  async issueForRide(
    input: IssueInvoiceInput,
    tx?: Tx,
  ): Promise<InvoiceRecord | null> {
    if (!this.enabled) return null;
    if (input.grossPaise <= 0) {
      // A zero-value supply (fully discounted ride) needs no tax invoice.
      return null;
    }

    const run = (t: Tx) => this.issueInTx(t, input);
    return tx ? run(tx) : this.db.transaction(run);
  }

  private async issueInTx(
    tx: Tx,
    input: IssueInvoiceInput,
  ): Promise<InvoiceRecord> {
    const existing = await this.findByRide(tx, input.rideId);
    if (existing) {
      // Already invoiced — return it rather than burning a second number.
      return this.toRecord(existing);
    }

    const financialYear = this.financialYearFor(new Date());
    const invoiceNumber = await this.nextInvoiceNumber(tx, financialYear);

    const placeOfSupply = this.resolvePlaceOfSupply(input);
    const interState = this.isInterState(placeOfSupply);

    // Work backwards from the tax-inclusive gross.
    const { taxableValuePaise, taxPaise } = extractInclusiveTax(
      input.grossPaise,
      this.gstRatePercent,
    );
    // Re-split the exact extracted tax so the components sum to it precisely.
    const { cgstPaise, sgstPaise, igstPaise } = this.splitExactTax(
      taxPaise,
      interState,
    );

    try {
      const [row] = await tx
        .insert(invoices)
        .values({
          rideId: input.rideId,
          invoiceNumber,
          financialYear,
          status: 'ISSUED',
          taxableValuePaise,
          cgstPaise,
          sgstPaise,
          igstPaise,
          totalPaise: input.grossPaise,
          gstRatePercent: this.gstRatePercent,
          sacCode: this.sacCode,
          sellerGstin: this.sellerGstin,
          sellerLegalName: this.sellerLegalName,
          buyerGstin: input.buyerGstin,
          buyerLegalName: input.buyerLegalName,
          placeOfSupply,
          issuedAt: new Date(),
        })
        .returning();

      this.logger.log(
        `issued invoice ${invoiceNumber} for ride=${input.rideId} ` +
          `taxable=${taxableValuePaise} tax=${taxPaise} total=${input.grossPaise}`,
      );
      return this.toRecord(row);
    } catch (err) {
      if (this.isUniqueViolation(err)) {
        // Concurrent issuance for the same ride won the race.
        const winner = await this.findByRide(tx, input.rideId);
        if (winner) return this.toRecord(winner);
      }
      throw err;
    }
  }

  /**
   * Reserve the next number for a financial year.
   *
   * The `FOR UPDATE` on the counter row is the whole mechanism: it serialises
   * concurrent issuers so two rides cannot claim the same number, and because
   * it is a row lock inside the caller's transaction, a rollback releases the
   * number for reuse — which is what keeps the sequence gap-free.
   */
  private async nextInvoiceNumber(
    tx: Tx,
    financialYear: string,
  ): Promise<string> {
    // Create the counter on first use for this (year, series).
    await tx
      .insert(invoiceSequences)
      .values({ financialYear, series: this.series, lastNumber: 0 })
      .onConflictDoNothing({
        target: [invoiceSequences.financialYear, invoiceSequences.series],
      });

    const [locked] = await tx
      .select({ lastNumber: invoiceSequences.lastNumber })
      .from(invoiceSequences)
      .where(
        and(
          eq(invoiceSequences.financialYear, financialYear),
          eq(invoiceSequences.series, this.series),
        ),
      )
      .limit(1)
      .for('update');

    if (!locked) {
      throw new ConflictException(
        `Invoice counter for ${this.series}/${financialYear} is unavailable`,
      );
    }

    const next = locked.lastNumber + 1;
    await tx
      .update(invoiceSequences)
      .set({ lastNumber: next, updatedAt: new Date() })
      .where(
        and(
          eq(invoiceSequences.financialYear, financialYear),
          eq(invoiceSequences.series, this.series),
        ),
      );

    // OBN/2026-27/000001
    return `${this.series}/${financialYear}/${String(next).padStart(6, '0')}`;
  }

  /** Invoice for a ride, for the receipt screen. */
  async getForRide(rideId: string): Promise<InvoiceRecord | null> {
    const row = await this.findByRide(this.db, rideId);
    return row ? this.toRecord(row) : null;
  }

  async getByNumber(invoiceNumber: string): Promise<InvoiceRecord> {
    const [row] = await this.db
      .select()
      .from(invoices)
      .where(eq(invoices.invoiceNumber, invoiceNumber))
      .limit(1);
    if (!row) {
      throw new NotFoundException(`Invoice ${invoiceNumber} not found`);
    }
    return this.toRecord(row);
  }

  /**
   * Cancel an issued invoice (a credit-note equivalent).
   *
   * The number is NOT reused: a cancelled invoice must remain visible in the
   * sequence, otherwise the gap-free guarantee is broken and an auditor sees a
   * missing number instead of a cancelled supply.
   */
  async cancel(
    rideId: string,
    cancellationReason: string,
  ): Promise<InvoiceRecord> {
    if (!cancellationReason?.trim()) {
      throw new BadRequestException(
        'cancellationReason is required to cancel an invoice',
      );
    }

    return this.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(invoices)
        .set({
          status: 'CANCELLED',
          cancelledAt: new Date(),
          cancellationReason,
        })
        .where(and(eq(invoices.rideId, rideId), eq(invoices.status, 'ISSUED')))
        .returning();

      if (!updated) {
        throw new NotFoundException(
          `No issued invoice found for ride ${rideId}`,
        );
      }
      this.logger.warn(
        `cancelled invoice ${updated.invoiceNumber} (ride=${rideId}): ${cancellationReason}`,
      );
      return this.toRecord(updated);
    });
  }

  /**
   * GSTR-1 style export for a financial year — the monthly filing input.
   * Includes CANCELLED rows on purpose: the filing must account for every
   * number in the series.
   */
  async listForFinancialYear(
    financialYear: string,
    limit = 1000,
    offset = 0,
  ): Promise<InvoiceRecord[]> {
    const rows = await this.db
      .select()
      .from(invoices)
      .where(eq(invoices.financialYear, financialYear))
      .orderBy(invoices.invoiceNumber)
      .limit(Math.min(limit, 5000))
      .offset(offset);
    return rows.map((r) => this.toRecord(r));
  }

  /**
   * Detect gaps in a year's sequence. A gap means a number was minted and the
   * row never committed — the invariant this service exists to protect — so
   * this is the assertion an auditor (or a nightly check) actually cares about.
   */
  async findSequenceGaps(financialYear: string): Promise<number[]> {
    const [counter] = await this.db
      .select({ lastNumber: invoiceSequences.lastNumber })
      .from(invoiceSequences)
      .where(
        and(
          eq(invoiceSequences.financialYear, financialYear),
          eq(invoiceSequences.series, this.series),
        ),
      )
      .limit(1);
    if (!counter || counter.lastNumber === 0) return [];

    const rows = await this.db
      .select({ invoiceNumber: invoices.invoiceNumber })
      .from(invoices)
      .where(eq(invoices.financialYear, financialYear));

    const present = new Set(
      rows
        .map((r) => Number(r.invoiceNumber.split('/').pop()))
        .filter((n) => Number.isFinite(n)),
    );
    const gaps: number[] = [];
    for (let n = 1; n <= counter.lastNumber; n += 1) {
      if (!present.has(n)) gaps.push(n);
    }
    return gaps;
  }

  /**
   * Split an already-extracted tax amount into components without re-rounding.
   *
   * `splitGst` computes tax from a taxable value; here the tax is already known
   * exactly (it is the remainder of the inclusive extraction), so re-deriving
   * it would risk a one-paise disagreement with `totalPaise` and trip
   * `CHK_invoices_total`. CGST takes the floor, SGST the remainder.
   */
  private splitExactTax(
    taxPaise: number,
    interState: boolean,
  ): { cgstPaise: number; sgstPaise: number; igstPaise: number } {
    if (interState) {
      return { cgstPaise: 0, sgstPaise: 0, igstPaise: taxPaise };
    }
    const cgstPaise = Math.floor(taxPaise / 2);
    return { cgstPaise, sgstPaise: taxPaise - cgstPaise, igstPaise: 0 };
  }

  /**
   * Indian financial year label for a date: April 1 → March 31.
   * A ride on 2026-03-31 belongs to 2025-26; on 2026-04-01 to 2026-27.
   */
  financialYearFor(date: Date): string {
    const year = date.getFullYear();
    const month = date.getMonth(); // 0-based; March = 2
    const startYear = month >= 3 ? year : year - 1;
    return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
  }

  /**
   * Resolve the place of supply to a GST STATE CODE.
   *
   * This distinction is load-bearing and easy to get wrong: place of supply is a
   * state, but every caller upstream holds a city (`rides.city`). Comparing
   * "Hyderabad" against the seller code "TS" makes an intra-state ride look
   * inter-state, which files the entire return under IGST instead of CGST+SGST.
   *
   * An unknown city falls back to the seller's own state (intra-state) rather
   * than guessing inter-state: over-collecting IGST on a domestic supply is the
   * more damaging error, and the fallback is logged so the gap gets fixed.
   */
  private resolvePlaceOfSupply(input: IssueInvoiceInput): string {
    if (input.placeOfSupplyStateCode) {
      return input.placeOfSupplyStateCode.trim().toUpperCase();
    }
    if (input.city) {
      const resolved = stateCodeForCity(input.city);
      if (resolved) return resolved.toUpperCase();
      this.logger.warn(
        `no GST state code mapped for city "${input.city}" — defaulting place ` +
          `of supply to seller state ${this.sellerStateCode}. Add the city to ` +
          'SERVICE_CITY_CENTERS.',
      );
    }
    return this.sellerStateCode.trim().toUpperCase();
  }

  private isInterState(placeOfSupplyStateCode: string): boolean {
    return (
      placeOfSupplyStateCode.trim().toUpperCase() !==
      this.sellerStateCode.trim().toUpperCase()
    );
  }

  private async findByRide(
    exec: DrizzleDB | Tx,
    rideId: string,
  ): Promise<typeof invoices.$inferSelect | undefined> {
    const [row] = await exec
      .select()
      .from(invoices)
      .where(eq(invoices.rideId, rideId))
      .limit(1);
    return row;
  }

  private toRecord(row: typeof invoices.$inferSelect): InvoiceRecord {
    return {
      id: row.id,
      rideId: row.rideId,
      invoiceNumber: row.invoiceNumber,
      financialYear: row.financialYear,
      status: row.status,
      taxableValuePaise: row.taxableValuePaise,
      cgstPaise: row.cgstPaise,
      sgstPaise: row.sgstPaise,
      igstPaise: row.igstPaise,
      totalPaise: row.totalPaise,
      gstRatePercent: Number(row.gstRatePercent),
      sacCode: row.sacCode,
      buyerGstin: row.buyerGstin ?? undefined,
      placeOfSupply: row.placeOfSupply ?? undefined,
      issuedAt: row.issuedAt?.toISOString(),
    };
  }

  /** Drizzle wraps pg errors — the code lives on `.cause`. */
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
}
