import { timingSafeEqual } from 'node:crypto';
import { Controller, Get, Headers, Inject, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { CONFIG, METRICS } from '../../../../../config/tokens';
import type { AppConfig } from '../../../../../config/env';
import type { MetricsPort } from '../../../application/ports/misc-ports';
import { Public } from '../../http/decorators';

/**
 * `/metrics` exige `Authorization: Bearer <METRICS_AUTH_TOKEN>` sempre que o token
 * estiver configurado (obrigatório em produção). Sem token, permanece aberto para
 * o scrape local — `METRICS_ENABLED=false` desliga o endpoint por completo.
 */
@Controller('metrics')
export class MetricsController {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(METRICS) private readonly metrics: MetricsPort,
  ) {}

  @Public()
  @Get()
  async get(
    @Headers('authorization') authorization: string | undefined,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    if (!this.config.env.METRICS_ENABLED) {
      reply.status(404).send({ status: 404, code: 'METRICS_DISABLED' });
      return;
    }

    const expected = this.config.env.METRICS_AUTH_TOKEN;
    if (expected && !this.matches(authorization, expected)) {
      reply
        .status(401)
        .header('www-authenticate', 'Bearer realm="metrics"')
        .send({ status: 401, code: 'METRICS_UNAUTHORIZED' });
      return;
    }

    const body = await this.metrics.render();
    reply.status(200).header('content-type', this.metrics.contentType).send(body);
  }

  private matches(authorization: string | undefined, expected: string): boolean {
    const token = authorization?.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length)
      : '';
    const provided = Buffer.from(token, 'utf8');
    const secret = Buffer.from(expected, 'utf8');
    if (provided.length !== secret.length) return false;
    return timingSafeEqual(provided, secret);
  }
}
