import { IdempotencyConflictError } from '../../domain/errors/domain-errors';
import { InboxMessage } from '../../domain/inbox/inbox-message';
import { Currency, type SupportedCurrencies } from '../../domain/money/currency';
import { Money, type MoneyProps } from '../../domain/money/money';
import type { Wallet } from '../../domain/wallet/wallet';
import type { TraceContext } from '../../domain/outbox/outbox-message';
import { FailureCode } from '../../domain/transaction/failure-code';
import { WagerTransaction } from '../../domain/transaction/wager-transaction';
import {
  isExternalKind,
  WagerTransactionKind,
} from '../../domain/transaction/wager-transaction-kind';
import { WagerTransactionStatus } from '../../domain/transaction/wager-transaction-status';
import type {
  Clock,
  IdGenerator,
  LoggerPort,
  MetricsPort,
  ProviderDirectory,
  Tracer,
} from '../ports/misc-ports';
import type { TransactionRunner, UnitOfWork } from '../ports/unit-of-work';
import { computeWagerPayloadHash } from '../dto/payload-hash';
import { persistRejection } from './rejection';
import { executeSettlement } from './settlement-core';

export interface SubmitWagerTransactionCommand {
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: MoneyProps;
  readonly referenceExternalTransactionId?: string;
  readonly idempotencyKey?: string;
  readonly channel: 'http' | 'sqs';
  readonly correlationId: string;
  readonly causationId?: string;
  readonly traceContext?: TraceContext | null;
  readonly inbox?: { readonly messageId: string; readonly payloadHash: string };
}

export interface SubmitWagerTransactionResult {
  readonly transactionId: string | null;
  readonly status: WagerTransactionStatus;
  readonly balance: MoneyProps | null;
  readonly failureCode: FailureCode | null;
  readonly idempotentReplay: boolean;
  readonly duplicateMessage: boolean;
  readonly walletId: string | null;
  /** gatilho oportunista de dependentes (executado pelo chamador, fora da tx). */
  readonly settled: { providerId: string; externalTransactionId: string } | null;
}

const CONSUMER_NAME = 'wager-transactions';

/** Estado imutável de uma tentativa, compartilhado pelos passos do caso de uso. */
interface SubmissionContext {
  readonly uow: UnitOfWork;
  readonly cmd: SubmitWagerTransactionCommand;
  readonly now: Date;
}

/**
 * Caso de uso único para HTTP e SQS (ADR-03): inbox → idempotência → lock da
 * wallet → regras → saldo + journal + 2 pernas → snapshot → outbox → inbox
 * processed → COMMIT. Nenhuma chamada de rede dentro da transação.
 *
 * O fluxo é dividido em passos nomeados (`claimInbox`, `buildTransaction`,
 * `resolveConflict`, `lockAndAuthorizeWallet`, `settle`) para que cada regra
 * tenha um único motivo para mudar.
 */
export class SubmitWagerTransaction {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly providers: ProviderDirectory,
    private readonly currencies: SupportedCurrencies,
    private readonly tracer: Tracer,
    private readonly metrics: MetricsPort,
    private readonly logger: LoggerPort,
  ) {}

  async execute(
    cmd: SubmitWagerTransactionCommand,
  ): Promise<SubmitWagerTransactionResult> {
    return this.tracer.withRemoteSpan(
      cmd.traceContext ?? null,
      'usecase.submit',
      { channel: cmd.channel, kind: cmd.kind, provider: cmd.providerId },
      async (span) => {
        const result = await this.runner.run(async (uow) =>
          this.runInTransaction(uow, cmd),
        );
        span.setAttribute('status.final', result.status);
        this.metrics.recordTransaction(cmd.kind, result.status, cmd.providerId);
        return result;
      },
    );
  }

  private async runInTransaction(
    uow: UnitOfWork,
    cmd: SubmitWagerTransactionCommand,
  ): Promise<SubmitWagerTransactionResult> {
    const context: SubmissionContext = { uow, cmd, now: this.clock.now() };
    const payloadHash = this.payloadHashOf(cmd);
    const idempotencyKey = this.resolveIdempotencyKey(cmd);

    // (2) inbox persistente (somente canal SQS)
    const inboxReplay = await this.claimInbox(context);
    if (inboxReplay) return inboxReplay;

    // (3) claim de idempotência
    const walletExists = await uow.wallets.exists(cmd.walletId);
    const transaction = this.buildTransaction(cmd, {
      idempotencyKey,
      payloadHash,
      walletExists,
      now: context.now,
    });

    const claim = await uow.transactions.insertPending(transaction);
    if (claim.outcome === 'conflict') {
      return this.resolveConflict(context, transaction, idempotencyKey, payloadHash);
    }

    // (5) validações que não dependem do estado da wallet
    const preValidation = this.preValidate(cmd, walletExists);
    if (preValidation) {
      return this.reject(context, transaction, preValidation, null);
    }

    // (4) lock da wallet + (4.1) tenancy
    const wallet = await uow.wallets.findByIdForUpdate(cmd.walletId);
    if (!wallet) {
      return this.reject(context, transaction, FailureCode.WalletNotFound, null);
    }
    if (this.ownershipOf(wallet, cmd.providerId) === 'foreign') {
      return this.reject(context, transaction, FailureCode.ProviderMismatch, null);
    }
    if (wallet.providerId === null) {
      // adoção exclusiva sob o lock já adquirido
      const adopted = await this.claimWalletOwnership(context, wallet);
      if (!adopted) {
        return this.reject(context, transaction, FailureCode.ProviderMismatch, null);
      }
    }

    // (6–10) referência + settlement + persistência atômica + eventos
    return this.settle(context, wallet, transaction);
  }

  private payloadHashOf(cmd: SubmitWagerTransactionCommand): string {
    return computeWagerPayloadHash({
      providerId: cmd.providerId,
      externalTransactionId: cmd.externalTransactionId,
      playerId: cmd.playerId,
      walletId: cmd.walletId,
      roundId: cmd.roundId,
      gameId: cmd.gameId,
      kind: cmd.kind,
      money: cmd.money,
      referenceExternalTransactionId: cmd.referenceExternalTransactionId ?? null,
    });
  }

  /**
   * Namespace obrigatório: a chave é global no banco, então o provedor entra no
   * prefixo para impedir colisão/replay cruzado entre tenants.
   */
  private resolveIdempotencyKey(cmd: SubmitWagerTransactionCommand): string {
    const derivedKey = `${cmd.providerId}:${cmd.externalTransactionId}`;
    const rawKey = cmd.idempotencyKey?.trim();
    if (!rawKey) return derivedKey;
    if (rawKey !== cmd.externalTransactionId) {
      this.logger.warn(
        {
          providerId: cmd.providerId,
          externalTransactionId: cmd.externalTransactionId,
        },
        'idempotencyKey customizada — prefixada com o provedor',
      );
    }
    return `${cmd.providerId}:${rawKey}`;
  }

  /** Deduplicação de entrega (SQS): mensagem já processada vira replay sem efeito. */
  private async claimInbox(
    context: SubmissionContext,
  ): Promise<SubmitWagerTransactionResult | null> {
    const { uow, cmd, now } = context;
    if (!cmd.inbox) return null;

    const claim = await uow.inbox.claim(
      InboxMessage.receive({
        consumerName: CONSUMER_NAME,
        messageId: cmd.inbox.messageId,
        payloadHash: cmd.inbox.payloadHash,
        receivedAt: now,
      }),
    );
    if (claim.inserted || !claim.alreadyProcessed) return null;

    this.metrics.recordDuplicate('replay', 'sqs');
    return {
      transactionId: null,
      status: WagerTransactionStatus.Processed,
      balance: null,
      failureCode: null,
      idempotentReplay: true,
      duplicateMessage: true,
      walletId: null,
      settled: null,
    };
  }

  private buildTransaction(
    cmd: SubmitWagerTransactionCommand,
    input: {
      idempotencyKey: string;
      payloadHash: string;
      walletExists: boolean;
      now: Date;
    },
  ): WagerTransaction {
    return WagerTransaction.create({
      id: this.ids.next(),
      providerId: cmd.providerId,
      externalTransactionId: cmd.externalTransactionId,
      idempotencyKey: input.idempotencyKey,
      payloadHash: input.payloadHash,
      walletId: input.walletExists ? cmd.walletId : null,
      playerId: cmd.playerId,
      roundId: cmd.roundId,
      gameId: cmd.gameId,
      kind: cmd.kind,
      money: Money.from(cmd.money),
      referenceExternalTransactionId: cmd.referenceExternalTransactionId,
      createdAt: input.now,
    });
  }

  /**
   * Conflito de unicidade: replay (payload idêntico), conflito real (payload
   * divergente) ou estorno repetido (índice parcial de REFUND/ROLLBACK).
   */
  private async resolveConflict(
    context: SubmissionContext,
    transaction: WagerTransaction,
    idempotencyKey: string,
    payloadHash: string,
  ): Promise<SubmitWagerTransactionResult> {
    const { uow, cmd, now } = context;
    const existing =
      (await uow.transactions.findByIdempotencyKey(idempotencyKey)) ??
      (await uow.transactions.findByProviderExternalId(
        cmd.providerId,
        cmd.externalTransactionId,
      ));

    if (!existing) {
      // Conflito no índice parcial de estorno: rejeição de negócio — nunca 500.
      if (transaction.requiresReference() && transaction.referenceExternalTransactionId) {
        const alreadyApplied = await uow.transactions.existsProcessedReversal(
          transaction.providerId,
          transaction.referenceExternalTransactionId,
          transaction.kind,
        );
        if (alreadyApplied) {
          transaction.reject(FailureCode.ReversalAlreadyApplied, now, undefined);
          await this.markInboxProcessed(context);
          return this.resultOf(transaction, null);
        }
      }
      throw new Error(
        `conflito de idempotência sem registro correspondente (${idempotencyKey})`,
      );
    }

    if (existing.matchesPayload(payloadHash)) {
      this.metrics.recordDuplicate('replay', cmd.channel);
      await this.markInboxProcessed(context);
      return this.replayResult(existing);
    }

    this.metrics.recordDuplicate('conflict', cmd.channel);
    throw new IdempotencyConflictError(idempotencyKey);
  }

  /**
   * Tenancy: a wallet pertence a um único provedor. Wallet sem dono é adotada na
   * primeira operação; depois disso só o dono opera.
   */
  private ownershipOf(
    wallet: Wallet,
    providerId: string,
  ): 'owner' | 'adoptable' | 'foreign' {
    if (wallet.providerId === providerId) return 'owner';
    return wallet.providerId === null ? 'adoptable' : 'foreign';
  }

  /** Adoção exclusiva: só vence se `provider_id` ainda for NULL na linha travada. */
  private async claimWalletOwnership(
    context: SubmissionContext,
    wallet: Wallet,
  ): Promise<boolean> {
    const claimed = await context.uow.wallets.claimProvider(
      wallet.id,
      context.cmd.providerId,
    );
    if (claimed) return true;
    const reloaded = await context.uow.wallets.findByIdForUpdate(wallet.id);
    return reloaded?.providerId === context.cmd.providerId;
  }

  private async settle(
    context: SubmissionContext,
    wallet: Wallet,
    transaction: WagerTransaction,
  ): Promise<SubmitWagerTransactionResult> {
    const { uow, cmd, now } = context;

    let reference: WagerTransaction | null = null;
    let reversalAlreadyApplied = false;
    if (transaction.referenceExternalTransactionId) {
      reference = await uow.transactions.findByProviderExternalId(
        transaction.providerId,
        transaction.referenceExternalTransactionId,
      );
      if (reference && transaction.requiresReference()) {
        reversalAlreadyApplied = await uow.transactions.existsProcessedReversal(
          transaction.providerId,
          transaction.referenceExternalTransactionId,
          transaction.kind,
          reference.kind,
        );
      }
    }

    const decision = await executeSettlement({
      uow,
      wallet,
      transaction,
      reference,
      reversalAlreadyApplied,
      now,
      ids: this.ids,
      tracer: this.tracer,
      correlationId: cmd.correlationId,
      causationId: cmd.causationId,
    });

    await this.markInboxProcessed(context);

    const result = this.resultOf(transaction, wallet);
    return {
      ...result,
      settled:
        decision.outcome === 'PROCESSED'
          ? {
              providerId: transaction.providerId,
              externalTransactionId: transaction.externalTransactionId,
            }
          : null,
    };
  }

  private preValidate(
    cmd: SubmitWagerTransactionCommand,
    walletExists: boolean,
  ): FailureCode | null {
    if (!this.providers.isAllowed(cmd.providerId)) {
      return FailureCode.UnknownProvider;
    }
    if (!Currency.isSupported(cmd.money.currency, this.currencies)) {
      return FailureCode.UnsupportedCurrency;
    }
    if (!isExternalKind(cmd.kind)) {
      return FailureCode.OpeningNotAllowed;
    }
    if (!walletExists) {
      return FailureCode.WalletNotFound;
    }
    return null;
  }

  /** Persiste a rejeição auditável + marca o inbox e devolve o resultado. */
  private async reject(
    context: SubmissionContext,
    transaction: WagerTransaction,
    failureCode: FailureCode,
    resultingBalance: Money | null,
    wallet: Wallet | null = null,
  ): Promise<SubmitWagerTransactionResult> {
    const { uow, cmd, now } = context;
    await persistRejection({
      uow,
      transaction,
      failureCode,
      resultingBalance,
      now,
      ids: this.ids,
      tracer: this.tracer,
      correlationId: cmd.correlationId,
      causationId: cmd.causationId,
    });
    await this.markInboxProcessed(context);
    return this.resultOf(transaction, wallet);
  }

  private async markInboxProcessed(context: SubmissionContext): Promise<void> {
    const { uow, cmd, now } = context;
    if (!cmd.inbox) return;
    await uow.inbox.markProcessed(CONSUMER_NAME, cmd.inbox.messageId, now);
  }

  private replayResult(
    transaction: WagerTransaction,
  ): SubmitWagerTransactionResult {
    return {
      transactionId: transaction.id,
      status: transaction.status,
      balance: transaction.resultingBalance
        ? transaction.resultingBalance.toJSON()
        : null,
      failureCode: transaction.failureCode ?? null,
      idempotentReplay: true,
      duplicateMessage: false,
      walletId: transaction.walletId,
      settled: null,
    };
  }

  private resultOf(
    transaction: WagerTransaction,
    wallet: Wallet | null,
  ): SubmitWagerTransactionResult {
    const snapshot = transaction.resultingBalance
      ? transaction.resultingBalance.toJSON()
      : wallet
        ? wallet.balance.toJSON()
        : null;
    return {
      transactionId: transaction.id,
      status: transaction.status,
      balance: snapshot,
      failureCode: transaction.failureCode ?? null,
      idempotentReplay: false,
      duplicateMessage: false,
      walletId: transaction.walletId,
      settled: null,
    };
  }
}
