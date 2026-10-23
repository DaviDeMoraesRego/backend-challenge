import { WalletAlreadyExistsError } from '../../domain/errors/domain-errors';
import { Currency, type SupportedCurrencies } from '../../domain/money/currency';
import { Money, type MoneyProps } from '../../domain/money/money';
import { WagerTransaction } from '../../domain/transaction/wager-transaction';
import { WagerTransactionKind } from '../../domain/transaction/wager-transaction-kind';
import { Wallet } from '../../domain/wallet/wallet';
import { isUniqueViolation } from '../db-error';
import { computeOpeningPayloadHash } from '../dto/payload-hash';
import type { Clock, IdGenerator, Tracer } from '../ports/misc-ports';
import type { TransactionRunner } from '../ports/unit-of-work';
import { executeSettlement } from './settlement-core';

export interface OpenWalletCommand {
  readonly playerId: string;
  readonly initialBalance?: MoneyProps;
  readonly correlationId: string;
  readonly causationId?: string;
  /** provedor dono da wallet; ausente quando aberta pelo backoffice. */
  readonly providerId?: string | null;
}

export interface OpenWalletResult {
  readonly id: string;
  readonly playerId: string;
  readonly balance: MoneyProps;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const SYSTEM = 'system';

/**
 * Criação da wallet + OPENING (quando initialBalance > 0) na **mesma transação SQL**
 * (plans/02 §4.4). Saldo inicial zero ⇒ sem transação/journal/lançamentos (version 1).
 */
export class OpenWallet {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly currencies: SupportedCurrencies,
    private readonly tracer: Tracer,
    private readonly defaultCurrency: string,
  ) {}

  async execute(cmd: OpenWalletCommand): Promise<OpenWalletResult> {
    const currencyCode = cmd.initialBalance?.currency ?? this.defaultCurrency;
    Currency.of(currencyCode, this.currencies);
    const initial = cmd.initialBalance
      ? Money.from(cmd.initialBalance)
      : Money.zero(currencyCode);
    if (initial.isNegative()) {
      throw new Error('initialBalance não pode ser negativo');
    }
    const now = this.clock.now();
    const walletId = this.ids.next();

    try {
      return await this.runner.run(async (uow) => {
        const wallet = Wallet.open({
          id: walletId,
          playerId: cmd.playerId,
          providerId: cmd.providerId ?? null,
          currency: currencyCode,
          now,
        });
        await uow.wallets.insert(wallet);

        if (initial.isPositive()) {
          const opening = WagerTransaction.create({
            id: this.ids.next(),
            providerId: SYSTEM,
            externalTransactionId: `opening:${wallet.id}`,
            idempotencyKey: `system:opening:${wallet.id}`,
            payloadHash: computeOpeningPayloadHash({
              walletId: wallet.id,
              playerId: wallet.playerId,
              amount: initial.toString(),
              currency: wallet.currency,
            }),
            walletId: wallet.id,
            playerId: wallet.playerId,
            roundId: SYSTEM,
            gameId: SYSTEM,
            kind: WagerTransactionKind.Opening,
            money: initial,
            createdAt: now,
          });
          await uow.transactions.insertPending(opening);

          const decision = await executeSettlement({
            uow,
            wallet,
            transaction: opening,
            reference: null,
            reversalAlreadyApplied: false,
            now,
            ids: this.ids,
            tracer: this.tracer,
            correlationId: cmd.correlationId,
            causationId: cmd.causationId,
            internal: true,
          });
          if (decision.outcome !== 'PROCESSED') {
            throw new Error(
              `OPENING não aplicada (${decision.outcome}) para wallet ${wallet.id}`,
            );
          }
        }

        return {
          id: wallet.id,
          playerId: wallet.playerId,
          balance: wallet.balance.toJSON(),
          version: wallet.version,
          createdAt: wallet.createdAt,
          updatedAt: wallet.updatedAt,
        };
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new WalletAlreadyExistsError(cmd.playerId, currencyCode);
      }
      throw error;
    }
  }
}
