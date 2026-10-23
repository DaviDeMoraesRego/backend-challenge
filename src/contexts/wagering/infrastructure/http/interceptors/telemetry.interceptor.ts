import {
  HttpException,
  Inject,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { METRICS } from '../../../../../config/tokens';
import type { MetricsPort } from '../../../application/ports/misc-ports';

/**
 * Status HTTP efetivo do erro: `HttpException` (401/403/409/422/503) não pode ser
 * contabilizado como 5xx, senão rejeição de negócio polui o SLO de erro.
 */
const statusOfError = (error: unknown): number =>
  error instanceof HttpException ? error.getStatus() : 500;

/** Mede duração e conta requisições — não transforma payload (plans/06 §4.7). */
@Injectable()
export class TelemetryInterceptor implements NestInterceptor {
  constructor(@Inject(METRICS) private readonly metrics: MetricsPort) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const startedAt = performance.now();
    const request = context.switchToHttp().getRequest<{
      method?: string;
      routeOptions?: { url?: string };
      routerPath?: string;
      url?: string;
    }>();
    const response = context
      .switchToHttp()
      .getResponse<{ statusCode?: number }>();

    const finalize = (error?: unknown): void => {
      const status =
        error !== undefined ? statusOfError(error) : (response.statusCode ?? 200);
      const statusClass = `${Math.floor(status / 100)}xx`;
      const route = request.routeOptions?.url ?? request.routerPath ?? 'unknown';
      this.metrics.observeHttp(
        route,
        request.method ?? 'UNKNOWN',
        statusClass,
        (performance.now() - startedAt) / 1000,
      );
    };

    return next.handle().pipe(
      tap({
        next: () => finalize(),
        error: (error) => finalize(error),
      }),
    );
  }
}
