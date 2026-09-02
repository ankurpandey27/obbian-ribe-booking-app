import { Module } from '@nestjs/common';
import { WalletLedgerService } from '../payments/wallet-ledger.service';
import { LedgerReconciliationService } from '../payments/ledger-reconciliation.service';

/**
 * LedgerModule — the driver wallet ledger, extracted as its own module.
 *
 * WHY IT IS SEPARATE FROM PaymentsModule:
 * Both `rides` (credit the driver on completion) and `payments` (settlement
 * payouts) need to write ledger entries. Leaving the ledger inside
 * PaymentsModule created a cycle — PaymentsModule already imports RidesModule —
 * and `forwardRef()` would only paper over it.
 *
 * The split is also the honest boundary: the ledger is a distinct future
 * service (`ledger-svc`, AGENTS.md §5). Payments moves money between rider and
 * platform; the ledger records money owed between platform and driver. Different
 * consumers, different retention, different service after extraction.
 *
 * Nothing else in the codebase may write `drivers.walletBalancePaise` —
 * every mutation goes through WalletLedgerService (ADR-012).
 */
@Module({
  providers: [WalletLedgerService, LedgerReconciliationService],
  exports: [WalletLedgerService],
})
export class LedgerModule {}
