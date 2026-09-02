import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DRIZZLE_DB, DrizzleDB } from '../../common/database/drizzle.module';
import {
  driverVehicles,
  drivers as driversTable,
} from '../../common/database/schema';
import { AddVehicleDto } from './dto/compliance.dto';
import { DriverDocumentsService } from './driver-documents.service';

const PG_UNIQUE_VIOLATION = '23505';

export type VehicleRow = typeof driverVehicles.$inferSelect;

/**
 * DriverVehiclesService — the fleet a driver may operate.
 *
 * Replaces the 1:1 `drivers.vehicleRegistration` / `vehicleType` columns. Those
 * lost history on every vehicle swap and, because `vehicleRegistration` was
 * UNIQUE on `drivers`, a captain moving to a new auto hit a conflict on a
 * routine event.
 *
 * `drivers.activeVehicleId` names the vehicle currently in service. It matters
 * beyond bookkeeping: insurance on a retired vehicle says nothing about the one
 * being driven today, so compliance is evaluated against the ACTIVE vehicle
 * only (see DriverDocumentsService.evaluate).
 */
@Injectable()
export class DriverVehiclesService {
  private readonly logger = new Logger(DriverVehiclesService.name);

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDB,
    private readonly documents: DriverDocumentsService,
  ) {}

  /**
   * Add a vehicle. The first vehicle a driver adds becomes active
   * automatically — otherwise they would add one, see nothing change, and have
   * no obvious next step.
   */
  async add(driverId: string, dto: AddVehicleDto): Promise<VehicleRow> {
    const registrationNumber = this.normaliseRegistration(
      dto.registrationNumber,
    );

    return this.db.transaction(async (tx) => {
      const [driver] = await tx
        .select({
          userId: driversTable.userId,
          activeVehicleId: driversTable.activeVehicleId,
        })
        .from(driversTable)
        .where(eq(driversTable.userId, driverId))
        .limit(1)
        .for('update');

      if (!driver) {
        throw new NotFoundException(
          `Driver profile ${driverId} not found — register as a driver first`,
        );
      }

      let vehicle: VehicleRow;
      try {
        const [inserted] = await tx
          .insert(driverVehicles)
          .values({
            driverId,
            registrationNumber,
            vehicleType: dto.vehicleType,
            make: dto.make,
            model: dto.model,
            color: dto.color,
            manufactureYear: dto.manufactureYear,
            seatingCapacity: dto.seatingCapacity,
            isVerified: false,
            isActive: true,
          })
          .returning();
        vehicle = inserted;
      } catch (err) {
        if (this.isUniqueViolation(err)) {
          // Registration numbers are globally unique — a plate can only be on
          // one account. Do not reveal whose.
          throw new ConflictException(
            `Vehicle ${registrationNumber} is already registered`,
          );
        }
        throw err;
      }

      if (!driver.activeVehicleId) {
        await tx
          .update(driversTable)
          .set({
            activeVehicleId: vehicle.id,
            vehicleType: vehicle.vehicleType,
            updatedAt: new Date(),
          })
          .where(eq(driversTable.userId, driverId));
      }

      // A new (unverified) vehicle becoming active removes eligibility until
      // its RC and insurance are verified.
      await this.documents.recomputeEligibility(tx, driverId);

      return vehicle;
    });
  }

  /** Vehicles on the account, active first. */
  async listForDriver(driverId: string): Promise<VehicleRow[]> {
    return this.db
      .select()
      .from(driverVehicles)
      .where(eq(driverVehicles.driverId, driverId))
      .orderBy(
        sql`${driverVehicles.isActive} DESC, ${driverVehicles.createdAt} DESC`,
      );
  }

  /**
   * Switch the vehicle in service.
   *
   * Mirrors `vehicleType` onto `drivers` because matching filters on it, and
   * re-evaluates compliance: swapping to a vehicle whose insurance is not
   * verified must stop dispatch immediately rather than at the next sweep.
   */
  async setActive(driverId: string, vehicleId: string): Promise<VehicleRow> {
    return this.db.transaction(async (tx) => {
      const [vehicle] = await tx
        .select()
        .from(driverVehicles)
        .where(
          and(
            eq(driverVehicles.id, vehicleId),
            eq(driverVehicles.driverId, driverId),
          ),
        )
        .limit(1);

      if (!vehicle) {
        throw new NotFoundException(`Vehicle ${vehicleId} not found`);
      }
      if (!vehicle.isActive) {
        throw new BadRequestException(
          'Cannot put a retired vehicle back into service',
        );
      }

      await tx
        .update(driversTable)
        .set({
          activeVehicleId: vehicle.id,
          vehicleType: vehicle.vehicleType,
          updatedAt: new Date(),
        })
        .where(eq(driversTable.userId, driverId));

      const evaluation = await this.documents.recomputeEligibility(
        tx,
        driverId,
      );

      this.logger.log(
        `driver=${driverId} active vehicle → ${vehicle.registrationNumber} ` +
          `(compliance ${evaluation.isComplianceVerified ? 'ok' : 'incomplete'})`,
      );

      return vehicle;
    });
  }

  /**
   * Retire a vehicle (sold, written off).
   *
   * Soft delete: ride history references the vehicle, and destroying it would
   * make past trips unexplainable. Retiring the ACTIVE vehicle clears the
   * pointer and revokes eligibility — there is no vehicle to dispatch.
   */
  async retire(driverId: string, vehicleId: string): Promise<VehicleRow> {
    return this.db.transaction(async (tx) => {
      const [vehicle] = await tx
        .update(driverVehicles)
        .set({ isActive: false, retiredAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(driverVehicles.id, vehicleId),
            eq(driverVehicles.driverId, driverId),
            eq(driverVehicles.isActive, true),
          ),
        )
        .returning();

      if (!vehicle) {
        throw new NotFoundException(
          `Active vehicle ${vehicleId} not found for this driver`,
        );
      }

      const [driver] = await tx
        .select({ activeVehicleId: driversTable.activeVehicleId })
        .from(driversTable)
        .where(eq(driversTable.userId, driverId))
        .limit(1)
        .for('update');

      if (driver?.activeVehicleId === vehicleId) {
        await tx
          .update(driversTable)
          .set({ activeVehicleId: null, updatedAt: new Date() })
          .where(eq(driversTable.userId, driverId));
      }

      await this.documents.recomputeEligibility(tx, driverId);
      return vehicle;
    });
  }

  /**
   * Plate numbers are written inconsistently ("ts 09 ab 1234", "TS09AB1234").
   * Normalising to uppercase alphanumerics is what makes the UNIQUE constraint
   * meaningful — otherwise the same vehicle registers twice.
   */
  private normaliseRegistration(raw: string): string {
    const normalised = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (normalised.length < 4) {
      throw new BadRequestException(
        'registrationNumber must contain at least 4 alphanumeric characters',
      );
    }
    return normalised;
  }

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
