import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { HealthService } from '../services/health.service';
import { HealthDto } from '../dto/health.dto';
import { Public } from '../../../common/auth/decorators';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  @Public()
  @ApiOperation({ summary: 'Liveness + DB/Redis dependency checks' })
  @ApiOkResponse({ type: HealthDto })
  check(): Promise<HealthDto> {
    return this.healthService.check();
  }
}
