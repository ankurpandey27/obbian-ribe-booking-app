import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Driver } from '../entities/driver.entity';
import { GeoService } from '../../../common/redis/geo.service';
import { DriverStatusValue, RideTypeValue } from '../../../shared/types/common';
import {
  UserLookupPort,
  USER_LOOKUP,
} from '../../../shared/contracts/user-lookup.port';
import { RegisterDriverDto } from '../dto/drivers.dto';

const HEARTBEAT_TTL_SECONDS = 90;

/**
 * DriversService — driver profile + online status + live position.
 * Online state lives in Redis (geo index + heartbeat TTL); profile in DB.
 * Auto-offline: if a driver stops pinging for 90s they drop out of the
 * geo index — a dead driver can never be matched.
 */
@Injectable()
export class DriversService {
  constructor(
    @InjectRepository(Driver) private readonly driverRepo: Repository<Driver>,
    private readonly geo: GeoService,
    @Inject(USER_LOOKUP) private readonly users: UserLookupPort,
  ) {}

  /**
   * Register driver profile + promote user role to DRIVER.
   * Client re-verifies OTP afterwards to pick up the DRIVER role in the JWT.
   */
  async register(userId: string, dto: RegisterDriverDto): Promise<Driver> {
    const existing = await this.driverRepo.findOneBy({ userId });
    if (existing) {
      throw new NotFoundException(
        'Driver profile already exists for this user',
      );
    }

    await this.users.updateRole(userId, 'DRIVER');
    const driver = await this.driverRepo.save({
      userId,
      licenseNumber: dto.licenseNumber,
      vehicleRegistration: dto.vehicleRegistration,
      vehicleModel: dto.vehicleModel,
      vehicleColor: dto.vehicleColor,
      vehicleType: dto.vehicleType,
      upiId: dto.upiId,
      status: 'OFFLINE',
    });
    return driver;
  }

  async getProfile(driverId: string): Promise<Driver> {
    const driver = await this.driverRepo.findOneBy({ userId: driverId });
    if (!driver) throw new NotFoundException(`Driver ${driverId} not found`);
    return driver;
  }

  async updateStatus(
    driverId: string,
    status: DriverStatusValue,
  ): Promise<void> {
    await this.getProfile(driverId);
    await this.driverRepo.update(driverId, {
      status,
      onlineSince: status === 'ONLINE' ? new Date() : undefined,
    });

    if (status === 'OFFLINE' || status === 'ON_RIDE') {
      await this.geo.removeDriverPosition(driverId);
    }
  }

  /**
   * Post-completion restore: driver back ONLINE, re-added to the geo
   * pool at the pickup point + rides count bumped. Called by RidesService
   * on RIDE_COMPLETED.
   */
  async completeRide(
    driverId: string,
    lat: number,
    lon: number,
  ): Promise<void> {
    await this.driverRepo.update(driverId, {
      status: 'ONLINE',
      onlineSince: new Date(),
    });
    await this.driverRepo.increment({ userId: driverId }, 'totalRides', 1);
    await this.geo.upsertDriverPosition(driverId, lon, lat);
    await this.geo.cacheDriverPosition(driverId, lat, lon, Date.now());
    await this.setHeartbeat(driverId);
  }

  /**
   * Live position update — refreshes geo index + heartbeat TTL.
   * Also writes the location cache the tracking service (REST fallback)
   * reads when the rider's socket is down.
   * Only ONLINE or ON_RIDE drivers stay matchable.
   */
  async updateLocation(
    driverId: string,
    lat: number,
    lon: number,
    timestamp?: number,
  ): Promise<void> {
    await this.geo.upsertDriverPosition(driverId, lon, lat);
    await this.geo.cacheDriverPosition(
      driverId,
      lat,
      lon,
      timestamp ?? Date.now(),
    );
    await this.driverRepo.update(driverId, {
      lastLocationUpdateAt: new Date(),
    });

    // Heartbeat TTL: expires → driver auto-removed from matchable pool.
    await this.setHeartbeat(driverId);
  }

  /** Refresh online heartbeat. Called on every location ping. */
  async setHeartbeat(driverId: string): Promise<void> {
    await this.geo.setHeartbeat(driverId, HEARTBEAT_TTL_SECONDS);
  }

  /** Returns candidate drivers for matching, pre-filtered by vehicle type. */
  async findMatchableDrivers(
    lon: number,
    lat: number,
    radiusKm: number,
    vehicleType: RideTypeValue,
    limit = 20,
  ): Promise<Driver[]> {
    const ids = await this.geo.findNearbyDriverIds(lon, lat, radiusKm, limit);
    if (ids.length === 0) return [];

    return this.driverRepo
      .createQueryBuilder('d')
      .where('d.userId IN (:...ids)', { ids })
      .andWhere('d.status = :status', { status: 'ONLINE' })
      .andWhere('d.vehicleType = :vehicleType', { vehicleType })
      .orderBy('d.rating', 'DESC')
      .getMany();
  }

  /** Validate a location ping is plausible (max 200 km/h vs last position). */
  async validateLocationJump(
    driverId: string,
    lat: number,
    lon: number,
    timestamp: number,
  ): Promise<boolean> {
    const prev = await this.geo.getDriverPosition(driverId);
    if (!prev) return true;

    const timeDiff = (timestamp - prev.timestamp) / 1000;
    if (timeDiff <= 0) return false;

    const distKm = this.haversine(prev.lat, prev.lon, lat, lon);
    const maxKm = (200 / 3600) * timeDiff;
    return distKm <= maxKm + 0.05;
  }

  async getNearbyDriverIds(
    lon: number,
    lat: number,
    radiusKm: number,
    limit = 50,
  ): Promise<string[]> {
    return this.geo.findNearbyDriverIds(lon, lat, radiusKm, limit);
  }

  private haversine(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number,
  ): number {
    const R = 6371;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
}
