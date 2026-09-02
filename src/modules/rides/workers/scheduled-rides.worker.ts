import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { QUEUE_SCHEDULED } from '../../../common/queues/queues.module';
import { ScheduledRidesService } from '../scheduled-rides.service';

/**
 * ScheduledRidesWorker — fires delayed jobs for future-dated bookings.
 * Ride materialisation goes through the normal request path, so matching
 * and dispatch happen automatically.
 */
@Processor(QUEUE_SCHEDULED)
export class ScheduledRidesWorker extends WorkerHost {
  private readonly logger = new Logger(ScheduledRidesWorker.name);

  constructor(private readonly scheduledRides: ScheduledRidesService) {
    super();
  }

  async process(job: Job<{ scheduledRideId: string }>): Promise<unknown> {
    this.logger.log(
      `Dispatching scheduled ride job ${job.id} (attempt ${job.attemptsMade + 1})`,
    );
    const ride = await this.scheduledRides.dispatch(job.data.scheduledRideId);
    return ride ? { rideId: ride.id, status: ride.status } : { skipped: true };
  }
}
