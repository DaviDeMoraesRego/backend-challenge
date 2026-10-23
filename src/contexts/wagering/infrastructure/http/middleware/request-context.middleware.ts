import { Injectable, type NestMiddleware } from '@nestjs/common';
import { requestContext } from '../../observability/als/request-context';
import { resolveCorrelationId } from '../../observability/als/correlation';

/** Popula o AsyncLocalStorage por request (plans/06 §4.3). */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(
    request: { headers: Record<string, string | undefined> },
    _response: unknown,
    next: () => void,
  ): void {
    const correlationId = resolveCorrelationId(request.headers['x-correlation-id']);
    requestContext.run({ correlationId }, () => next());
  }
}
