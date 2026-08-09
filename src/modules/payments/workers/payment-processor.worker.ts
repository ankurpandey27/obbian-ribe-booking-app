import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { QUEUE_PAYMENTS } from '../../../common/queues/queues.module';
import { PaymentsService } from '../services/payments.service';

/**
 * Payment worker — creates Razorpay orders from the queue.
 * Retries with exponential backoff (3 attempts by default queue config).
 */
@Processor(QUEUE_PAYMENTS)
export class PaymentProcessorWorker extends WorkerHost {
  private readonly logger = new Logger(PaymentProcessorWorker.name);

  constructor(private readonly paymentsService: PaymentsService) {
    super();
  }

  async process(
    job: Job<{
      paymentId: string;
      rideId: string;
      amount: number;
      method: string;
    }>,
  ): Promise<unknown> {
    this.logger.log(
      `Processing payment job ${job.id} (attempt ${job.attemptsMade + 1})`,
    );
    return this.paymentsService.processOrderJob(job.data);
  }
}
