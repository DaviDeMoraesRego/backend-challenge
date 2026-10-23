import pino, { type Logger } from 'pino';
import type { LoggerPort } from '../../../application/ports/misc-ports';
import { requestContext } from '../als/request-context';

class PinoLoggerAdapter implements LoggerPort {
  constructor(private readonly logger: Logger) {}

  debug(payload: Record<string, unknown>, message?: string): void {
    this.logger.debug(payload, message);
  }

  info(payload: Record<string, unknown>, message?: string): void {
    this.logger.info(payload, message);
  }

  warn(payload: Record<string, unknown>, message?: string): void {
    this.logger.warn(payload, message);
  }

  error(payload: Record<string, unknown>, message?: string): void {
    this.logger.error(payload, message);
  }

  child(bindings: Record<string, unknown>): LoggerPort {
    return new PinoLoggerAdapter(this.logger.child(bindings));
  }
}

/**
 * Logs estruturados (JSON) com correlação via ALS e redaction de dados sensíveis
 * (README §12 — nunca payload financeiro completo, nunca authorization).
 */
export function createLogger(options: {
  level: string;
  role: string;
  instanceId: string;
}): LoggerPort {
  const logger = pino({
    level: options.level,
    base: { role: options.role, instanceId: options.instanceId, service: 'wagering' },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        'req.headers.authorization',
        'authorization',
        'payload',
        'data.money',
        'money',
        'req.body',
      ],
      censor: '[redacted]',
    },
    mixin: () => {
      const store = requestContext.get();
      if (!store) return {};
      return {
        correlationId: store.correlationId,
        traceId: store.traceId,
        spanId: store.spanId,
        messageId: store.messageId,
        transactionId: store.transactionId,
        walletId: store.walletId,
        providerId: store.providerId,
      };
    },
  });
  return new PinoLoggerAdapter(logger);
}
