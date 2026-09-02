import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { QUEUE_MATCHING } from '../../../common/queues/queues.module';
import { MatchingService } from '../matching.service';

/**
 * Matching worker — runs the dispatch loop off the HTTP path.
 * A crash mid-match is safe to retry: the ride is still REQUESTED and
 * the atomic claim key guarantees only one driver can ever accept.
 */
@Processor(QUEUE_MATCHING)
export class MatchingWorker extends WorkerHost {
  private readonly logger = new Logger(MatchingWorker.name);

  constructor(private readonly matching: MatchingService) {
    super();
  }

  async process(job: Job<{ rideId: string }>): Promise<void> {
    const { rideId } = job.data;
    try {
      await this.matching.matchRide(rideId);
    } catch (err) {
      this.logger.error(`matchRide(${rideId}) failed`, (err as Error).message);
      throw err;
    }
  }
}
