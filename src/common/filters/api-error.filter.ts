import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import type { ApiEnvelopeDto } from '../dto/api-envelope.dto';

/**
 * Global exception filter — enforces the unified error envelope.
 * All failures (validation, HttpException, unknown 500s) produce:
 * { success, message, messageCode, data, error, path, requestId, timestamp }
 * with success:false, data:null and the error carried in `error`.
 */
@Catch()
export class ApiErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiErrorFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const requestId =
      (request.headers['x-request-id'] as string) || randomUUID();

    let status: number;
    let errorCode: string;
    let message: string | string[];

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'string') {
        message = body;
        errorCode = (exception as Error).name;
      } else {
        const b = body as Record<string, unknown>;
        message =
          (b.message as string | string[]) ?? (exception as Error).message;
        errorCode = (b.error as string) ?? (exception as Error).name;
      }
    } else {
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      message = 'Internal server error';
      errorCode = 'Internal Server Error';
      this.logger.error(
        `Unhandled error ${request.method} ${request.originalUrl}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    const envelope: ApiEnvelopeDto = {
      timestamp: new Date().toISOString(),
      path: request.originalUrl ?? request.url ?? '',
      requestId,
      success: false,
      message: typeof message === 'string' ? message : 'Validation failed',
      messageCode: status,
      data: null,
      error: { code: errorCode, message, details: null },
    };

    response.setHeader('x-request-id', requestId);
    response.status(status).json(envelope);
  }
}
