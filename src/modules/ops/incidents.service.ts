import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { randomBytes } from 'crypto';
import { DRIZZLE_DB, DrizzleDB } from '../../common/database/drizzle.module';
import { incidents } from '../../common/database/schema';
import { CreateIncidentDto } from './dto/ops.dto';

@Injectable()
export class IncidentsService {
  private readonly referencePrefix: string;
  private readonly autoEscalateCritical: boolean;

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDB,
    config: ConfigService,
  ) {
    this.referencePrefix = config.get<string>(
      'incident.referencePrefix',
      'INC',
    );
    this.autoEscalateCritical = config.get<boolean>(
      'incident.autoEscalateCritical',
      true,
    );
  }

  async create(reportedByUserId: string, dto: CreateIncidentDto) {
    const severity =
      this.autoEscalateCritical &&
      (dto.incidentType === 'ACCIDENT' || dto.incidentType === 'HARASSMENT')
        ? 'CRITICAL'
        : (dto.severity ?? 'MEDIUM');
    const [row] = await this.db
      .insert(incidents)
      .values({
        reference: `${this.referencePrefix}-${randomBytes(4).toString('hex').toUpperCase()}`,
        reportedByUserId,
        rideId: dto.rideId,
        againstUserId: dto.againstUserId,
        incidentType: dto.incidentType,
        severity,
        description: dto.description,
        attachmentKeys: dto.attachmentKeys,
      })
      .returning();
    return row;
  }

  async listForReporter(userId: string, limit = 50, offset = 0) {
    return this.db
      .select()
      .from(incidents)
      .where(eq(incidents.reportedByUserId, userId))
      .orderBy(desc(incidents.createdAt))
      .limit(Math.min(Math.max(limit, 1), 100))
      .offset(Math.max(offset, 0));
  }

  async queue(limit = 50, offset = 0) {
    return this.db
      .select()
      .from(incidents)
      .where(inArray(incidents.status, ['OPEN', 'TRIAGED', 'INVESTIGATING']))
      .orderBy(desc(incidents.severity), incidents.createdAt)
      .limit(Math.min(Math.max(limit, 1), 100))
      .offset(Math.max(offset, 0));
  }

  async assign(id: string, assignedToUserId: string) {
    const [row] = await this.db
      .update(incidents)
      .set({ assignedToUserId, status: 'TRIAGED', updatedAt: new Date() })
      .where(
        and(
          eq(incidents.id, id),
          inArray(incidents.status, ['OPEN', 'TRIAGED', 'INVESTIGATING']),
        ),
      )
      .returning();
    if (!row)
      throw new NotFoundException('Incident not found or already closed');
    return row;
  }

  async resolve(
    id: string,
    actorUserId: string,
    dto: {
      resolution: string;
      compensationPaise?: number;
      status?: 'RESOLVED' | 'DISMISSED';
    },
  ) {
    const [row] = await this.db
      .update(incidents)
      .set({
        status: dto.status ?? 'RESOLVED',
        resolution: dto.resolution,
        compensationPaise: dto.compensationPaise ?? 0,
        resolvedByUserId: actorUserId,
        resolvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(incidents.id, id),
          inArray(incidents.status, ['OPEN', 'TRIAGED', 'INVESTIGATING']),
        ),
      )
      .returning();
    if (!row)
      throw new NotFoundException('Incident not found or already closed');
    return row;
  }

  async getById(id: string) {
    const [row] = await this.db
      .select()
      .from(incidents)
      .where(eq(incidents.id, id))
      .limit(1);
    if (!row) throw new NotFoundException('Incident not found');
    return row;
  }
}
