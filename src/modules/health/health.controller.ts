import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import {
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { HealthService } from './health.service';
import { HealthDto, LivenessDto } from './dto/health.dto';
import { Public } from '../../common/auth/decorators';

/**
 * Probe endpoints.
 *
 * `@SkipThrottle()` on the whole controller: kubelet probes every pod every few
 * seconds from a single node IP, and the global limit (100 req/min per IP) would
 * eventually answer a probe with 429. Kubernetes treats any non-2xx liveness
 * response as a dead container, so rate-limiting these routes causes a
 * self-inflicted restart loop under exactly the load where restarts hurt most.
 */
@ApiTags('health')
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  @Public()
  @ApiOperation({
    summary:
      'Full health report: process uptime plus DB/Redis dependency checks',
  })
  @ApiOkResponse({ type: HealthDto })
  check(): Promise<HealthDto> {
    return this.healthService.check();
  }

  @Get('live')
  @Public()
  @ApiOperation({
    summary: 'Liveness probe — process only, never probes dependencies',
    description:
      'Always 200 while the event loop can answer. Wire this to livenessProbe: failing it restarts the container, which must never happen because a dependency is down.',
  })
  @ApiOkResponse({ type: LivenessDto })
  live(): LivenessDto {
    return this.healthService.liveness();
  }

  @Get('ready')
  @Public()
  @ApiOperation({
    summary: 'Readiness probe — dependencies reachable and not draining',
    description:
      'Returns 503 when a dependency is unreachable or the process is shutting down, so the pod is taken out of load balancing without being restarted.',
  })
  @ApiOkResponse({ type: HealthDto })
  @ApiServiceUnavailableResponse({ type: HealthDto })
  async ready(@Res({ passthrough: true }) res: Response): Promise<HealthDto> {
    const report = await this.healthService.readiness();
    if (report.status !== 'ok') {
      /*
       * Status set directly rather than by throwing ServiceUnavailableException:
       * the exception filter would replace this body with the generic error
       * envelope, and the whole value of a readiness response is being able to
       * see WHICH dependency failed without shelling into the pod.
       */
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
    }
    return report;
  }
}
