import { describe, expect, it } from 'bun:test';
import { parseCommandMessage } from '../../src/contexts/wagering/infrastructure/messaging/sqs-message-parser';
import { signEnvelopePayload } from '../../src/contexts/wagering/infrastructure/messaging/payload-signature';

const SECRET = 'segredo-de-teste-com-tamanho-suficiente-32';

const data = {
  providerId: 'provider-a',
  externalTransactionId: 'ext-1',
  idempotencyKey: 'ext-1',
  playerId: '018f2b3c-0000-7000-8000-000000000001',
  walletId: '018f2b3c-0000-7000-8000-000000000002',
  roundId: 'round-1',
  gameId: 'fortune-chimp',
  kind: 'BET' as const,
  money: { amount: '10.00', currency: 'BRL' },
};

const bodyWith = (signature?: string): string =>
  JSON.stringify({
    messageId: 'msg-1',
    type: 'WagerTransactionRequested',
    occurredAt: new Date(0).toISOString(),
    ...(signature ? { signature } : {}),
    data,
  });

describe('Segurança — assinatura do envelope SQS', () => {
  it('aceita envelope com HMAC correto', () => {
    const parsed = parseCommandMessage(bodyWith(signEnvelopePayload(SECRET, data)), {
      requireSignature: true,
      signingSecret: SECRET,
    });
    expect(parsed.ok).toBe(true);
  });

  it('rejeita envelope sem assinatura quando exigida', () => {
    const parsed = parseCommandMessage(bodyWith(), {
      requireSignature: true,
      signingSecret: SECRET,
    });
    expect(parsed.ok).toBe(false);
  });

  it('rejeita assinatura com payload adulterado', () => {
    const signature = signEnvelopePayload(SECRET, data);
    const tampered = bodyWith(signature).replace('"10.00"', '"99.00"');
    const parsed = parseCommandMessage(tampered, {
      requireSignature: true,
      signingSecret: SECRET,
    });
    expect(parsed.ok).toBe(false);
  });

  it('aceita envelope não assinado quando a exigência está desligada', () => {
    const parsed = parseCommandMessage(bodyWith(), { requireSignature: false });
    expect(parsed.ok).toBe(true);
  });

  it('rejeita amount fora do formato decimal', () => {
    const invalid = bodyWith().replace('"10.00"', '"1e5"');
    const parsed = parseCommandMessage(invalid, { requireSignature: false });
    expect(parsed.ok).toBe(false);
  });
});
