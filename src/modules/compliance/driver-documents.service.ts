import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, asc, eq, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import { DRIZZLE_DB, DrizzleDB } from '../../common/database/drizzle.module';
import {
  driverDocuments,
  driverVehicles,
  drivers as driversTable,
} from '../../common/database/schema';
import { OutboxService } from '../../common/events/outbox.service';
import { TOPICS } from '../../shared/events/topics';
import { ComplianceEventType } from '../../shared/events/contracts';
import {
  DocumentStatusValue,
  DriverDocumentTypeValue,
  REQUIRED_DRIVER_DOCUMENTS,
  VEHICLE_SCOPED_DOCUMENTS,
} from '../../shared/types/common';
import { SubmitDocumentDto, VerifyDocumentDto } from './dto/compliance.dto';

/** Open Drizzle transaction handle. */
type Tx = Parameters<Parameters<DrizzleDB['transaction']>[0]>[0];

const PG_UNIQUE_VIOLATION = '23505';

/** Statuses that occupy a document slot. Anything else is history. */
const LIVE_STATUSES: DocumentStatusValue[] = [
  'PENDING',
  'IN_REVIEW',
  'VERIFIED',
];

export interface ComplianceEvaluation {
  isComplianceVerified: boolean;
  missingDocuments: DriverDocumentTypeValue[];
  expiringSoon: DriverDocumentTypeValue[];
}

export type DocumentRow = typeof driverDocuments.$inferSelect;

/**
 * DriverDocumentsService — the regulatory dispatch gate.
 *
 * An Indian ride-hailing operator may not dispatch a driver whose driving
 * licence, registration certificate or insurance is unverified or lapsed.
 * Before this existed, `drivers.licenseNumber` was a free-text column: no
 * upload, no verification, no expiry. That was a launch blocker.
 *
 * The design keeps ONE fast flag on the hot path — `drivers.isComplianceVerified`
 * — and treats these tables as the evidence behind it. Matching reads the flag
 * (it is in the partial index `IDX_drivers_matchable`); it never joins documents.
 *
 * Every mutation recomputes the flag inside the same transaction, so the flag
 * can never disagree with the documents that justify it.
 */
@Injectable()
export class DriverDocumentsService {
  private readonly logger = new Logger(DriverDocumentsService.name);
  private readonly expiryWarningDays: number;

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDB,
    private readonly outbox: OutboxService,
    config: ConfigService,
  ) {
    this.expiryWarningDays = config.get<number>(
      'compliance.expiryWarningDays',
      15,
    );
  }

  /**
   * Driver uploads (or re-uploads) a document.
   *
   * Re-upload semantics: a slot holds exactly one live document
   * (UQ_driver_documents_live_slot, NULLS NOT DISTINCT). Submitting again
   * supersedes any PENDING/IN_REVIEW row for that slot rather than colliding —
   * a driver correcting a blurry photo should not need ops to intervene. A
   * VERIFIED row is NOT auto-superseded: replacing valid evidence has to be
   * explicit, so that returns a conflict.
   */
  async submit(
    driverId: string,
    dto: SubmitDocumentDto,
  ): Promise<{ document: DocumentRow; evaluation: ComplianceEvaluation }> {
    this.assertVehicleScope(dto.documentType, dto.vehicleId);

    return this.db.transaction(async (tx) => {
      await this.assertDriverExists(tx, driverId);
      if (dto.vehicleId) {
        await this.assertVehicleOwnedBy(tx, driverId, dto.vehicleId);
      }

      const existing = await this.findLiveSlot(
        tx,
        driverId,
        dto.documentType,
        dto.vehicleId,
      );

      if (existing?.status === 'VERIFIED') {
        throw new ConflictException(
          `${dto.documentType} is already verified. Ask support to replace it ` +
            'if the document has genuinely changed.',
        );
      }

      let document: DocumentRow;
      if (existing) {
        // Supersede the in-flight submission in place, carrying the attempt
        // count forward so ops can see churn on a slot.
        const [updated] = await tx
          .update(driverDocuments)
          .set({
            storageKey: dto.storageKey,
            documentNumber: dto.documentNumber,
            issuedAt: dto.issuedAt ? new Date(dto.issuedAt) : null,
            expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
            status: 'PENDING',
            rejectionReason: null,
            verifiedBy: null,
            verifiedAt: null,
            submissionCount: sql`${driverDocuments.submissionCount} + 1`,
            updatedAt: new Date(),
          })
          .where(eq(driverDocuments.id, existing.id))
          .returning();
        document = updated;
      } else {
        try {
          const [inserted] = await tx
            .insert(driverDocuments)
            .values({
              driverId,
              vehicleId: dto.vehicleId,
              documentType: dto.documentType,
              storageKey: dto.storageKey,
              documentNumber: dto.documentNumber,
              issuedAt: dto.issuedAt ? new Date(dto.issuedAt) : null,
              expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
              status: 'PENDING',
            })
            .returning();
          document = inserted;
        } catch (err) {
          if (this.isUniqueViolation(err)) {
            // Lost a race with a concurrent submit for the same slot.
            throw new ConflictException(
              `A submission for ${dto.documentType} is already in review`,
            );
          }
          throw err;
        }
      }

      // A new submission can only remove eligibility (the slot is no longer
      // VERIFIED), so re-evaluate before returning.
      const evaluation = await this.recomputeEligibility(tx, driverId);

      await this.outbox.write(tx, {
        topic: TOPICS.COMPLIANCE_EVENTS,
        type: ComplianceEventType.DOCUMENT_SUBMITTED,
        aggregateType: 'driver',
        aggregateId: driverId,
        payload: {
          driverId,
          documentId: document.id,
          documentType: document.documentType,
          vehicleId: document.vehicleId ?? undefined,
          status: document.status,
          occurredAt: new Date().toISOString(),
        },
      });

      return { document, evaluation };
    });
  }

  /**
   * Ops verdict on a submitted document.
   *
   * Approving flips the slot to VERIFIED and may grant dispatch eligibility;
   * rejecting frees the slot so the driver can re-upload. Both recompute the
   * driver flag in the same transaction as the verdict.
   */
  async review(
    documentId: string,
    reviewerId: string,
    dto: VerifyDocumentDto,
  ): Promise<{ document: DocumentRow; evaluation: ComplianceEvaluation }> {
    if (!dto.approved && !dto.rejectionReason) {
      throw new BadRequestException(
        'rejectionReason is required when rejecting a document',
      );
    }

    return this.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(driverDocuments)
        .where(eq(driverDocuments.id, documentId))
        .limit(1)
        .for('update');

      if (!current) {
        throw new NotFoundException(`Document ${documentId} not found`);
      }
      if (!LIVE_STATUSES.includes(current.status)) {
        // EXPIRED/REJECTED rows are history; a verdict on them is meaningless.
        throw new ConflictException(
          `Document ${documentId} is ${current.status} and cannot be reviewed`,
        );
      }

      const nextStatus: DocumentStatusValue = dto.approved
        ? 'VERIFIED'
        : 'REJECTED';
      const expiresAt = dto.expiresAt
        ? new Date(dto.expiresAt)
        : current.expiresAt;

      if (dto.approved && expiresAt && expiresAt.getTime() <= Date.now()) {
        // Verifying an already-lapsed document would grant eligibility that
        // the nightly sweep revokes minutes later.
        throw new BadRequestException(
          'Cannot verify a document whose expiry is already in the past',
        );
      }

      // Conditional update on the observed status — two reviewers acting at
      // once cannot both record a verdict.
      const [document] = await tx
        .update(driverDocuments)
        .set({
          status: nextStatus,
          verifiedBy: reviewerId,
          verifiedAt: new Date(),
          rejectionReason: dto.approved ? null : dto.rejectionReason,
          expiresAt: expiresAt ?? null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(driverDocuments.id, documentId),
            eq(driverDocuments.status, current.status),
          ),
        )
        .returning();

      if (!document) {
        throw new ConflictException(
          `Document ${documentId} was reviewed concurrently`,
        );
      }

      if (document.vehicleId) {
        await this.refreshVehicleVerification(tx, document.vehicleId);
      }
      const evaluation = await this.recomputeEligibility(tx, document.driverId);

      await this.outbox.write(tx, {
        topic: TOPICS.COMPLIANCE_EVENTS,
        type: dto.approved
          ? ComplianceEventType.DOCUMENT_VERIFIED
          : ComplianceEventType.DOCUMENT_REJECTED,
        aggregateType: 'driver',
        aggregateId: document.driverId,
        payload: {
          driverId: document.driverId,
          documentId: document.id,
          documentType: document.documentType,
          vehicleId: document.vehicleId ?? undefined,
          status: document.status,
          expiresAt: document.expiresAt?.toISOString(),
          reason: document.rejectionReason ?? undefined,
          occurredAt: new Date().toISOString(),
        },
      });

      return { document, evaluation };
    });
  }

  /** Every document for a driver, newest first. */
  async listForDriver(driverId: string): Promise<DocumentRow[]> {
    return this.db
      .select()
      .from(driverDocuments)
      .where(eq(driverDocuments.driverId, driverId))
      .orderBy(sql`${driverDocuments.createdAt} DESC`);
  }

  /** Ops review queue — oldest pending first (backed by a partial index). */
  async listReviewQueue(
    limit = 50,
    offset = 0,
  ): Promise<Array<DocumentRow & { vehicleRegistration: string | null }>> {
    return this.db
      .select({
        id: driverDocuments.id,
        driverId: driverDocuments.driverId,
        vehicleId: driverDocuments.vehicleId,
        documentType: driverDocuments.documentType,
        status: driverDocuments.status,
        storageKey: driverDocuments.storageKey,
        documentNumber: driverDocuments.documentNumber,
        issuedAt: driverDocuments.issuedAt,
        expiresAt: driverDocuments.expiresAt,
        verifiedBy: driverDocuments.verifiedBy,
        verifiedAt: driverDocuments.verifiedAt,
        rejectionReason: driverDocuments.rejectionReason,
        submissionCount: driverDocuments.submissionCount,
        createdAt: driverDocuments.createdAt,
        updatedAt: driverDocuments.updatedAt,
        vehicleRegistration: driverVehicles.registrationNumber,
      })
      .from(driverDocuments)
      .leftJoin(
        driverVehicles,
        eq(driverVehicles.id, driverDocuments.vehicleId),
      )
      .where(inArray(driverDocuments.status, ['PENDING', 'IN_REVIEW']))
      .orderBy(asc(driverDocuments.createdAt))
      .limit(Math.min(limit, 100))
      .offset(offset);
  }

  /** Current eligibility plus the evidence, for the driver app. */
  async getComplianceStatus(driverId: string): Promise<
    ComplianceEvaluation & {
      documents: DocumentRow[];
      lastCheckedAt: Date | null;
      activeVehicleId: string | null;
    }
  > {
    const [driver] = await this.db
      .select({
        isComplianceVerified: driversTable.isComplianceVerified,
        complianceCheckedAt: driversTable.complianceCheckedAt,
        activeVehicleId: driversTable.activeVehicleId,
      })
      .from(driversTable)
      .where(eq(driversTable.userId, driverId))
      .limit(1);

    if (!driver) {
      throw new NotFoundException(`Driver ${driverId} not found`);
    }

    const documents = await this.listForDriver(driverId);
    const evaluation = this.evaluate(documents, driver.activeVehicleId ?? null);

    return {
      ...evaluation,
      documents,
      lastCheckedAt: driver.complianceCheckedAt ?? null,
      activeVehicleId: driver.activeVehicleId ?? null,
    };
  }

  /**
   * Nightly sweep: flip VERIFIED documents past their expiry to EXPIRED and
   * revoke eligibility for the affected drivers.
   *
   * This is why expiry is enforced by a sweep rather than checked at match
   * time: matching reads one boolean from an index, and adding an expiry
   * comparison to the hot path would cost every dispatch decision.
   */
  async expireLapsedDocuments(now = new Date()): Promise<{
    expiredCount: number;
    affectedDrivers: string[];
  }> {
    const lapsed = await this.db
      .update(driverDocuments)
      .set({ status: 'EXPIRED', updatedAt: now })
      .where(
        and(
          eq(driverDocuments.status, 'VERIFIED'),
          isNotNull(driverDocuments.expiresAt),
          lte(driverDocuments.expiresAt, now),
        ),
      )
      .returning({
        id: driverDocuments.id,
        driverId: driverDocuments.driverId,
        documentType: driverDocuments.documentType,
        vehicleId: driverDocuments.vehicleId,
        expiresAt: driverDocuments.expiresAt,
      });

    const affectedDrivers = [...new Set(lapsed.map((d) => d.driverId))];

    for (const doc of lapsed) {
      await this.outbox
        .write(this.db, {
          topic: TOPICS.COMPLIANCE_EVENTS,
          type: ComplianceEventType.DOCUMENT_EXPIRED,
          aggregateType: 'driver',
          aggregateId: doc.driverId,
          payload: {
            driverId: doc.driverId,
            documentId: doc.id,
            documentType: doc.documentType,
            vehicleId: doc.vehicleId ?? undefined,
            status: 'EXPIRED',
            expiresAt: doc.expiresAt?.toISOString(),
            occurredAt: now.toISOString(),
          },
        })
        .catch((err) =>
          this.logger.error(
            `failed to emit DOCUMENT_EXPIRED for ${doc.id}: ${
              (err as Error).message
            }`,
          ),
        );
    }

    // Recompute per driver so a lapsed document actually stops dispatch.
    for (const driverId of affectedDrivers) {
      await this.db
        .transaction((tx) => this.recomputeEligibility(tx, driverId))
        .catch((err) =>
          this.logger.error(
            `failed to revoke eligibility for driver=${driverId}: ${
              (err as Error).message
            }`,
          ),
        );
    }

    if (lapsed.length > 0) {
      this.logger.warn(
        `expired ${lapsed.length} document(s) across ${affectedDrivers.length} driver(s)`,
      );
    }
    for (const vehicleId of new Set(
      lapsed.map((d) => d.vehicleId).filter((v): v is string => Boolean(v)),
    )) {
      await this.db
        .transaction((tx) => this.refreshVehicleVerification(tx, vehicleId))
        .catch(() => undefined);
    }

    return { expiredCount: lapsed.length, affectedDrivers };
  }

  /**
   * Documents lapsing inside the warning window — drives renewal reminders so
   * a driver loses income to an expiry they were never told about.
   */
  async findExpiringSoon(now = new Date()): Promise<
    Array<{
      driverId: string;
      documentId: string;
      documentType: DriverDocumentTypeValue;
      expiresAt: Date;
      daysUntilExpiry: number;
    }>
  > {
    const cutoff = new Date(now);
    cutoff.setDate(cutoff.getDate() + this.expiryWarningDays);

    const rows = await this.db
      .select({
        driverId: driverDocuments.driverId,
        documentId: driverDocuments.id,
        documentType: driverDocuments.documentType,
        expiresAt: driverDocuments.expiresAt,
      })
      .from(driverDocuments)
      .where(
        and(
          eq(driverDocuments.status, 'VERIFIED'),
          isNotNull(driverDocuments.expiresAt),
          lte(driverDocuments.expiresAt, cutoff),
        ),
      )
      .orderBy(asc(driverDocuments.expiresAt));

    return rows
      .filter((r) => r.expiresAt !== null && r.expiresAt > now)
      .map((r) => ({
        driverId: r.driverId,
        documentId: r.documentId,
        documentType: r.documentType,
        expiresAt: r.expiresAt,
        daysUntilExpiry: this.daysBetween(now, r.expiresAt),
      }));
  }

  /**
   * Recompute `drivers.isComplianceVerified` from the current documents and
   * persist it, emitting GRANTED/REVOKED only on an actual transition.
   *
   * Runs inside the caller's transaction so the flag and the documents that
   * justify it commit together — the flag can never be stale.
   */
  async recomputeEligibility(
    tx: Tx,
    driverId: string,
  ): Promise<ComplianceEvaluation> {
    const [driver] = await tx
      .select({
        isComplianceVerified: driversTable.isComplianceVerified,
        activeVehicleId: driversTable.activeVehicleId,
      })
      .from(driversTable)
      .where(eq(driversTable.userId, driverId))
      .limit(1)
      .for('update');

    if (!driver) {
      throw new NotFoundException(`Driver ${driverId} not found`);
    }

    const documents = await tx
      .select()
      .from(driverDocuments)
      .where(eq(driverDocuments.driverId, driverId));

    const evaluation = this.evaluate(documents, driver.activeVehicleId ?? null);
    const wasVerified = driver.isComplianceVerified;

    await tx
      .update(driversTable)
      .set({
        isComplianceVerified: evaluation.isComplianceVerified,
        complianceCheckedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(driversTable.userId, driverId));

    // Losing eligibility must also take the driver out of the dispatch pool
    // immediately; leaving them ONLINE would keep offering them rides until
    // their next status change.
    if (wasVerified && !evaluation.isComplianceVerified) {
      await tx
        .update(driversTable)
        .set({ status: 'OFFLINE', updatedAt: new Date() })
        .where(
          and(
            eq(driversTable.userId, driverId),
            eq(driversTable.status, 'ONLINE'),
          ),
        );
    }

    if (wasVerified !== evaluation.isComplianceVerified) {
      await this.outbox.write(tx, {
        topic: TOPICS.COMPLIANCE_EVENTS,
        type: evaluation.isComplianceVerified
          ? ComplianceEventType.DRIVER_COMPLIANCE_GRANTED
          : ComplianceEventType.DRIVER_COMPLIANCE_REVOKED,
        aggregateType: 'driver',
        aggregateId: driverId,
        payload: {
          driverId,
          isComplianceVerified: evaluation.isComplianceVerified,
          missingDocuments: evaluation.missingDocuments,
          occurredAt: new Date().toISOString(),
        },
      });
      this.logger.log(
        `driver=${driverId} compliance ${
          evaluation.isComplianceVerified ? 'GRANTED' : 'REVOKED'
        }${
          evaluation.missingDocuments.length > 0
            ? ` (missing: ${evaluation.missingDocuments.join(', ')})`
            : ''
        }`,
      );
    }

    return evaluation;
  }

  /**
   * Pure eligibility rule — every REQUIRED_DRIVER_DOCUMENTS slot must hold a
   * VERIFIED, unexpired document. Vehicle-scoped requirements are checked
   * against the driver's ACTIVE vehicle only: insurance on a retired vehicle
   * says nothing about the one they are driving today.
   *
   * Kept pure (no I/O) so the rule is directly unit-testable.
   */
  evaluate(
    documents: DocumentRow[],
    activeVehicleId: string | null,
    now = new Date(),
  ): ComplianceEvaluation {
    const missingDocuments: DriverDocumentTypeValue[] = [];
    const expiringSoon: DriverDocumentTypeValue[] = [];
    const warnCutoff = new Date(now);
    warnCutoff.setDate(warnCutoff.getDate() + this.expiryWarningDays);

    for (const required of REQUIRED_DRIVER_DOCUMENTS) {
      const vehicleScoped = VEHICLE_SCOPED_DOCUMENTS.includes(required);

      if (vehicleScoped && !activeVehicleId) {
        // No vehicle in service — the vehicle-scoped requirement is unmet by
        // definition.
        missingDocuments.push(required);
        continue;
      }

      const match = documents.find(
        (d) =>
          d.documentType === required &&
          d.status === 'VERIFIED' &&
          (vehicleScoped ? d.vehicleId === activeVehicleId : true),
      );

      if (!match) {
        missingDocuments.push(required);
        continue;
      }
      if (match.expiresAt && match.expiresAt <= now) {
        // VERIFIED but lapsed — the sweep has not run yet. Treat as missing
        // rather than waiting for the cron.
        missingDocuments.push(required);
        continue;
      }
      if (match.expiresAt && match.expiresAt <= warnCutoff) {
        expiringSoon.push(required);
      }
    }

    return {
      isComplianceVerified: missingDocuments.length === 0,
      missingDocuments,
      expiringSoon,
    };
  }

  /**
   * Mark a vehicle verified when all its vehicle-scoped documents are VERIFIED
   * and unexpired, and mirror the expiry dates onto the vehicle row so the
   * fleet sweep is one table scan.
   */
  private async refreshVehicleVerification(
    tx: Tx,
    vehicleId: string,
  ): Promise<void> {
    const docs = await tx
      .select()
      .from(driverDocuments)
      .where(eq(driverDocuments.vehicleId, vehicleId));

    const now = new Date();
    const valid = (type: DriverDocumentTypeValue) =>
      docs.find(
        (d) =>
          d.documentType === type &&
          d.status === 'VERIFIED' &&
          (!d.expiresAt || d.expiresAt > now),
      );

    const rc = valid('VEHICLE_REGISTRATION');
    const insurance = valid('VEHICLE_INSURANCE');

    await tx
      .update(driverVehicles)
      .set({
        isVerified: Boolean(rc && insurance),
        insuranceExpiresAt: insurance?.expiresAt ?? null,
        fitnessExpiresAt: valid('VEHICLE_FITNESS')?.expiresAt ?? null,
        permitExpiresAt: valid('VEHICLE_PERMIT')?.expiresAt ?? null,
        pucExpiresAt: valid('POLLUTION_CERTIFICATE')?.expiresAt ?? null,
        updatedAt: now,
      })
      .where(eq(driverVehicles.id, vehicleId));
  }

  private async findLiveSlot(
    tx: Tx,
    driverId: string,
    documentType: DriverDocumentTypeValue,
    vehicleId?: string,
  ): Promise<DocumentRow | undefined> {
    const [row] = await tx
      .select()
      .from(driverDocuments)
      .where(
        and(
          eq(driverDocuments.driverId, driverId),
          eq(driverDocuments.documentType, documentType),
          vehicleId
            ? eq(driverDocuments.vehicleId, vehicleId)
            : sql`${driverDocuments.vehicleId} IS NULL`,
          inArray(driverDocuments.status, LIVE_STATUSES),
        ),
      )
      .limit(1)
      .for('update');
    return row;
  }

  /**
   * Vehicle-scoped documents need a vehicle; person-scoped ones must not carry
   * one. Enforced here because the DB cannot express "NULL only for this
   * subset of an enum".
   */
  private assertVehicleScope(
    documentType: DriverDocumentTypeValue,
    vehicleId?: string,
  ): void {
    const requiresVehicle = VEHICLE_SCOPED_DOCUMENTS.includes(documentType);
    if (requiresVehicle && !vehicleId) {
      throw new BadRequestException(
        `${documentType} is vehicle-scoped — vehicleId is required`,
      );
    }
    if (!requiresVehicle && vehicleId) {
      throw new BadRequestException(
        `${documentType} is person-scoped — vehicleId must be omitted`,
      );
    }
  }

  private async assertDriverExists(tx: Tx, driverId: string): Promise<void> {
    const [driver] = await tx
      .select({ userId: driversTable.userId })
      .from(driversTable)
      .where(eq(driversTable.userId, driverId))
      .limit(1);
    if (!driver) {
      throw new NotFoundException(
        `Driver profile ${driverId} not found — register as a driver first`,
      );
    }
  }

  private async assertVehicleOwnedBy(
    tx: Tx,
    driverId: string,
    vehicleId: string,
  ): Promise<void> {
    const [vehicle] = await tx
      .select({ id: driverVehicles.id })
      .from(driverVehicles)
      .where(
        and(
          eq(driverVehicles.id, vehicleId),
          eq(driverVehicles.driverId, driverId),
        ),
      )
      .limit(1);
    if (!vehicle) {
      // Deliberately NotFound rather than Forbidden — do not confirm that a
      // vehicle id belonging to someone else exists.
      throw new NotFoundException(`Vehicle ${vehicleId} not found`);
    }
  }

  private daysBetween(from: Date, to: Date): number {
    return Math.ceil((to.getTime() - from.getTime()) / 86_400_000);
  }

  /**
   * Drizzle wraps driver errors, so the pg code lives on `.cause`. Walk the
   * chain (same reasoning as WalletLedgerService).
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
}
