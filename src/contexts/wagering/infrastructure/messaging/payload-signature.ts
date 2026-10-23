import { createHmac, timingSafeEqual } from 'node:crypto';
import { canonicalize, type CanonicalInput } from '../../../../shared/json/canonical';

/**
 * Assinatura do envelope SQS (fronteira de confiança da fila).
 * O MAC cobre apenas o subconjunto de negócio canônico (`data`), de modo que
 * metadados de transporte possam variar sem invalidar a assinatura.
 */
export function signEnvelopePayload(secret: string, data: CanonicalInput): string {
  return createHmac('sha256', secret).update(canonicalize(data), 'utf8').digest('hex');
}

export function verifyEnvelopeSignature(
  secret: string,
  data: CanonicalInput,
  signature: string,
): boolean {
  const expected = Buffer.from(signEnvelopePayload(secret, data), 'utf8');
  const received = Buffer.from(signature, 'utf8');
  if (expected.length !== received.length) return false;
  return timingSafeEqual(expected, received);
}
