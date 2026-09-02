/**
 * Money primitives. AGENTS.md §2: never do float arithmetic on money.
 *
 * PAISE (integer) is the unit of computation and of every new column. RUPEES
 * (numeric(10,2)) survives only on legacy core tables (rides.estimatedFare,
 * payments.amount, …) for API-contract compatibility — convert at the boundary
 * with toPaise/toRupees, never mid-calculation.
 *
 * All helpers are total: non-finite input clamps to 0 so a bad upstream value
 * degrades to "free" rather than NaN silently poisoning a ledger row.
 */

export const PAISE_PER_RUPEE = 100;

/** Rounds half-up on the paise boundary — Razorpay accepts integer paise only. */
export function toPaise(rupees: number): number {
  if (!Number.isFinite(rupees)) return 0;
  return Math.round(rupees * PAISE_PER_RUPEE);
}

export function toRupees(paise: number): number {
  if (!Number.isFinite(paise)) return 0;
  return Math.round(paise) / PAISE_PER_RUPEE;
}

/** Platform fare granularity — keeps sub-50-paise surge noise off receipts. */
export function roundToHalfRupee(paise: number): number {
  if (!Number.isFinite(paise)) return 0;
  return Math.round(paise / 50) * 50;
}

export function percentOf(paise: number, percent: number): number {
  if (!Number.isFinite(paise) || !Number.isFinite(percent)) return 0;
  return Math.round((paise * percent) / 100);
}

export function nonNegativePaise(paise: number): number {
  if (!Number.isFinite(paise)) return 0;
  return Math.max(0, Math.round(paise));
}

/**
 * Split GST into CGST/SGST (intra-state) or IGST (inter-state). Rounding is a
 * real trap: naively rounding both halves can drift a paise from the total
 * tax, so SGST is derived as the remainder and CGST + SGST === total exactly.
 */
export function splitGst(
  taxableValuePaise: number,
  gstRatePercent: number,
  interState: boolean,
): {
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  totalTaxPaise: number;
} {
  const totalTaxPaise = percentOf(
    nonNegativePaise(taxableValuePaise),
    gstRatePercent,
  );
  if (interState) {
    return {
      cgstPaise: 0,
      sgstPaise: 0,
      igstPaise: totalTaxPaise,
      totalTaxPaise,
    };
  }
  const cgstPaise = Math.floor(totalTaxPaise / 2);
  const sgstPaise = totalTaxPaise - cgstPaise;
  return { cgstPaise, sgstPaise, igstPaise: 0, totalTaxPaise };
}

/**
 * Tax already baked into a gross, GST-inclusive amount: Indian fares are
 * quoted tax-inclusive, so the invoice works backwards
 * (taxable = gross × 100 / (100 + rate)); tax is the remainder so the
 * parts re-add to gross exactly.
 */
export function extractInclusiveTax(
  grossPaise: number,
  gstRatePercent: number,
): { taxableValuePaise: number; taxPaise: number } {
  const gross = nonNegativePaise(grossPaise);
  if (gstRatePercent <= 0) {
    return { taxableValuePaise: gross, taxPaise: 0 };
  }
  const taxableValuePaise = Math.round((gross * 100) / (100 + gstRatePercent));
  return { taxableValuePaise, taxPaise: gross - taxableValuePaise };
}

export function formatPaise(paise: number): string {
  return `₹${toRupees(paise).toFixed(2)}`;
}
