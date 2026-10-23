import { sqsCommandEnvelopeSchema, type SqsCommandEnvelope } from '../../application/dto/schemas';
import { sha256Hex, type CanonicalInput } from '../../../../shared/json/canonical';
import { verifyEnvelopeSignature } from './payload-signature';

/** Converte o comando (já validado por zod) para a forma canônica, sem cast. */
function toCanonicalInput(data: SqsCommandEnvelope['data']): CanonicalInput {
  const keyed: Record<string, CanonicalInput> = {
    providerId: data.providerId,
    externalTransactionId: data.externalTransactionId,
    idempotencyKey: data.idempotencyKey,
    playerId: data.playerId,
    walletId: data.walletId,
    roundId: data.roundId,
    gameId: data.gameId,
    kind: data.kind,
    money: { amount: data.money.amount, currency: data.money.currency },
  };
  if (data.referenceExternalTransactionId !== undefined) {
    keyed.referenceExternalTransactionId = data.referenceExternalTransactionId;
  }
  return keyed;
}

export type ParseResult =
  | { readonly ok: true; readonly envelope: SqsCommandEnvelope; readonly payloadHash: string }
  | { readonly ok: false; readonly reason: string };

export interface ParseOptions {
  /** exige HMAC válido no envelope (fronteira de confiança fechada). */
  readonly requireSignature?: boolean;
  readonly signingSecret?: string;
}

/**
 * Envelope de comando validado por zod — erro aqui é **permanente** (DLQ explícita).
 * Quando `requireSignature` está ativo, mensagem sem assinatura válida nunca chega
 * ao use case: vai direto para a DLQ.
 */
export function parseCommandMessage(
  body: string | undefined,
  options: ParseOptions = {},
): ParseResult {
  if (!body) return { ok: false, reason: 'mensagem vazia' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, reason: 'JSON inválido' };
  }
  const result = sqsCommandEnvelopeSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      reason: result.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; '),
    };
  }

  const envelope = result.data;
  if (options.requireSignature) {
    if (!options.signingSecret) {
      return { ok: false, reason: 'assinatura exigida mas segredo não configurado' };
    }
    if (!envelope.signature) {
      return { ok: false, reason: 'assinatura ausente no envelope' };
    }
    const valid = verifyEnvelopeSignature(
      options.signingSecret,
      toCanonicalInput(envelope.data),
      envelope.signature,
    );
    if (!valid) {
      return { ok: false, reason: 'assinatura do envelope inválida' };
    }
  }

  return { ok: true, envelope, payloadHash: sha256Hex(body) };
}
