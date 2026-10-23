import {
  DomainError,
  InvalidMoneyError,
} from '../../domain/errors/domain-errors';
import { isTransientSqlState, extractSqlState } from '../persistence/sqlstate';

export type ErrorClass = 'business' | 'transient' | 'permanent';

const TEMPORARY_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'TimeoutError',
  'NetworkingError',
  'ThrottlingException',
  'ServiceUnavailable',
  'InternalError',
  'RequestTimeout',
]);

/**
 * Mensagens do driver/pool que indicam indisponibilidade temporária. `pg` e
 * `pg-pool` não expõem SQLSTATE em todos os caminhos (timeout de pool, socket
 * encerrado), então a borda HTTP depende desse sinal para responder 503.
 */
const TEMPORARY_MESSAGE =
  /(timeout|timed out|terminated unexpectedly|connection (refused|reset|closed|terminated)|ECONNREFUSED|ECONNRESET|ETIMEDOUT|too many clients|could not connect|server closed the connection)/i;

/** Percorre a cadeia de `cause` procurando sinal de indisponibilidade temporária. */
function hasTemporaryNetworkSignal(error: unknown): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const candidate = current as {
      name?: unknown;
      code?: unknown;
      statusCode?: unknown;
      $metadata?: { httpStatusCode?: number };
      cause?: unknown;
    };
    if (typeof candidate.name === 'string' && TEMPORARY_CODES.has(candidate.name)) {
      return true;
    }
    if (typeof candidate.code === 'string' && TEMPORARY_CODES.has(candidate.code)) {
      return true;
    }
    const message = (candidate as { message?: unknown }).message;
    if (typeof message === 'string' && TEMPORARY_MESSAGE.test(message)) {
      return true;
    }
    const status = candidate.$metadata?.httpStatusCode ?? candidate.statusCode;
    if (typeof status === 'number' && (status >= 500 || status === 429)) return true;
    current = candidate.cause ?? null;
  }
  return false;
}

/**
 * Falha de infraestrutura transitória (conexão caiu, lock timeout, 5xx do SDK).
 * Diferente de `classifyError`, **não** trata erro desconhecido como transitório:
 * a borda HTTP precisa distinguir 503 de um bug real (500).
 */
export function isTransientInfraError(error: unknown): boolean {
  if (isTransientSqlState(extractSqlState(error))) return true;
  return hasTemporaryNetworkSignal(error);
}

/**
 * Classificação exigida pelo README §10 (plans/05 §6):
 * negócio → ack; transitório → visibilidade com backoff; permanente → DLQ explícita.
 * Regras de domínio **nunca** são permanentes de fila (viram REJECTED persistido).
 */
export function classifyError(error: unknown): ErrorClass {
  // Valor monetário inválido nunca chega a ser persistido: ack silencioso
  // perderia a mensagem, então vai para a DLQ (permanente, auditável).
  if (error instanceof InvalidMoneyError) return 'permanent';
  if (error instanceof DomainError) return 'business';

  const sqlstate = extractSqlState(error);
  if (sqlstate) return isTransientSqlState(sqlstate) ? 'transient' : 'permanent';

  // Sem SQLSTATE e sem sinal de rede conhecido: na fila, retry com backoff é
  // preferível a perder a mensagem — o redrive limita a insistência.
  return 'transient';
}
