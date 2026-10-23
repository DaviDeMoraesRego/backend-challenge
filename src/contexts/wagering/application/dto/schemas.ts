import { z } from 'zod';

export const EXTERNAL_KIND_VALUES = ['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'] as const;

export const moneySchema = (supported: ReadonlySet<string>) =>
  z
    .object({
      amount: z
        .string()
        .regex(/^\d{1,17}(\.\d{1,2})?$/, 'amount deve ser decimal com até 2 casas'),
      currency: z
        .string()
        .length(3)
        .refine((code) => supported.has(code), { message: 'UNSUPPORTED_CURRENCY' }),
    })
    .strict();

/** providerId entra no namespace da idempotency key — `:` é proibido. */
export const providerIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'providerId inválido');

export const idempotencyKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/, 'idempotency key inválida');

export function createSubmitTransactionSchema(supported: ReadonlySet<string>) {
  return z
    .object({
      providerId: providerIdSchema,
      externalTransactionId: z.string().min(1).max(128),
      playerId: z.string().uuid(),
      walletId: z.string().uuid(),
      roundId: z.string().min(1).max(128),
      gameId: z.string().min(1).max(128),
      kind: z.enum(EXTERNAL_KIND_VALUES),
      money: moneySchema(supported),
      referenceExternalTransactionId: z.string().min(1).max(128).optional(),
    })
    .strict();
}

export type SubmitTransactionBody = z.infer<
  ReturnType<typeof createSubmitTransactionSchema>
>;

export function createOpenWalletSchema(supported: ReadonlySet<string>) {
  return z
    .object({
      playerId: z.string().uuid(),
      initialBalance: moneySchema(supported).optional(),
    })
    .strict();
}

export type OpenWalletBody = z.infer<ReturnType<typeof createOpenWalletSchema>>;

export const ledgerQuerySchema = z
  .object({
    cursor: z.string().min(1).max(256).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

export type LedgerQuery = z.infer<typeof ledgerQuerySchema>;

export const sqsCommandEnvelopeSchema = z
  .object({
    messageId: z.string().min(1).max(128),
    type: z.literal('WagerTransactionRequested'),
    occurredAt: z.string().min(1),
    /** HMAC-SHA256 (hex) do `data` canônico — obrigatório quando configurado. */
    signature: z.string().min(32).max(128).optional(),
    data: z
      .object({
        providerId: providerIdSchema,
        externalTransactionId: z.string().min(1).max(128),
        idempotencyKey: idempotencyKeySchema,
        playerId: z.string().uuid(),
        walletId: z.string().uuid(),
        roundId: z.string().min(1).max(128),
        gameId: z.string().min(1).max(128),
        kind: z.enum(EXTERNAL_KIND_VALUES),
        money: z
          .object({
            amount: z
              .string()
              .regex(/^\d{1,17}(\.\d{1,2})?$/, 'amount deve ser decimal com até 2 casas'),
            currency: z.string().regex(/^[A-Z]{3}$/, 'currency deve ser ISO-4217'),
          })
          .strict(),
        referenceExternalTransactionId: z.string().min(1).max(128).optional(),
      })
      .strict(),
  })
  .strict();

export type SqsCommandEnvelope = z.infer<typeof sqsCommandEnvelopeSchema>;
