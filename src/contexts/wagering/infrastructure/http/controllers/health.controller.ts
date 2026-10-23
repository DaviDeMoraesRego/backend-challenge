import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { READINESS_PROBE } from '../../../../../config/tokens';
import type { ReadinessProbe } from '../../../application/ports/misc-ports';
import { Public } from '../decorators';

@Controller('health')
export class HealthController {
  constructor(
    @Inject(READINESS_PROBE) private readonly readiness: ReadinessProbe,
  ) {}

  @Public()
  @Get('live')
  live(): { status: string } {
    return { status: 'ok' };
  }

  @Public()
  @Get('ready')
  async ready(
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const result = await this.readiness.check();
    const healthy = result.pg === 'up' && result.sqs === 'up';
    reply.status(healthy ? 200 : 503);
    return {
      status: healthy ? 'ok' : 'degraded',
      pg: result.pg,
      sqs: result.sqs,
    };
  }
}
