import { describe, expect, it } from 'bun:test';
import type { SubmitWagerTransactionCommand } from '../../src/contexts/wagering/application/use-cases/submit-wager-transaction';
import { SubmitWagerTransaction } from '../../src/contexts/wagering/application/use-cases/submit-wager-transaction';
import { OpenWallet } from '../../src/contexts/wagering/application/use-cases/open-wallet';
import { LedgerDirection } from '../../src/contexts/wagering/domain/ledger/ledger-direction';
import { FailureCode } from '../../src/contexts/wagering/domain/transaction/failure-code';
import { WagerTransactionKind } from '../../src/contexts/wagering/domain/transaction/wager-transaction-kind';
import { WagerTransactionStatus } from '../../src/contexts/wagering/domain/transaction/wager-transaction-status';
import { PromMetrics } from '../../src/contexts/wagering/infrastructure/observability/metrics/metrics.registry';
import { NoopTracer } from '../../src/contexts/wagering/infrastructure/observability/tracing/tracing';
import { createFakeUnitOfWork, type FakeUnitOfWork } from '../helpers/fake-unit-of-work';
import { RecordingLogger } from '../helpers/silent-logger';

const NOW = new Date('2026-01-01T00:00:00.000Z');
const PLAYER_ID = 'player-1';
const clock = { now: () => NOW };
const currencies = new Set(['BRL']);
const providers = {
  isAllowed: (providerId: string) =>
    providerId === 'provider-a' || providerId === 'provider-b',
};

interface Harness {
  readonly fake: FakeUnitOfWork;
  readonly submit: SubmitWagerTransaction;
  readonly openWallet: OpenWallet;
}

function setup(): Harness {
  const fake = createFakeUnitOfWork(() => NOW);
  let sequence = 0;
  const ids = { next: () => `id-${(sequence += 1)}` };
  const tracer = new NoopTracer();
  const metrics = new PromMetrics('test-submit', '1');
  const logger = new RecordingLogger();

  return {
    fake,
    submit: new SubmitWagerTransaction(
      fake.runner,
      clock,
      ids,
      providers,
      currencies,
      tracer,
      metrics,
      logger,
    ),
    openWallet: new OpenWallet(fake.runner, clock, ids, currencies, tracer, 'BRL'),
  };
}

async function openWalletWith(harness: Harness, amount = '100.00'): Promise<string> {
  const wallet = await harness.openWallet.execute({
    playerId: PLAYER_ID,
    initialBalance: { amount, currency: 'BRL' },
    correlationId: 'corr-open',
  });
  return wallet.id;
}

function command(
  walletId: string,
  overrides: Partial<SubmitWagerTransactionCommand> & {
    providerId: string;
    externalTransactionId: string;
    amount: string;
  },
): SubmitWagerTransactionCommand {
  return {
    walletId,
    playerId: PLAYER_ID,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.Bet,
    money: { amount: overrides.amount, currency: 'BRL' },
    channel: 'http',
    correlationId: 'corr-submit',
    ...overrides,
  };
}

describe('SubmitWagerTransaction — orquestração sem I/O', () => {
  it('BET debita e grava exatamente uma perna de wallet', async () => {
    const harness = setup();
    const walletId = await openWalletWith(harness);

    const result = await harness.submit.execute(
      command(walletId, {
        providerId: 'provider-a',
        externalTransactionId: 'ext-1',
        amount: '10.00',
      }),
    );

    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(result.balance).toEqual({ amount: '90.00', currency: 'BRL' });
    expect(result.idempotentReplay).toBe(false);
    expect(result.settled).toEqual({
      providerId: 'provider-a',
      externalTransactionId: 'ext-1',
    });

    const debits = harness.fake.ledger.walletEntries.filter(
      (entry) => entry.direction === LedgerDirection.Debit,
    );
    expect(debits).toHaveLength(1);
    // saldo + journal + 2 pernas + eventos na mesma unidade de trabalho
    expect(harness.fake.ledger.journals).toHaveLength(2); // OPENING + BET
    expect(harness.fake.outbox.messages.length).toBeGreaterThan(0);
  });

  it('replay idempotente não debita duas vezes', async () => {
    const harness = setup();
    const walletId = await openWalletWith(harness);
    const cmd = command(walletId, {
      providerId: 'provider-a',
      externalTransactionId: 'ext-replay',
      amount: '10.00',
    });

    const first = await harness.submit.execute(cmd);
    const second = await harness.submit.execute(cmd);

    expect(first.idempotentReplay).toBe(false);
    expect(second.idempotentReplay).toBe(true);
    expect(second.transactionId).toBe(first.transactionId);
    expect(second.balance).toEqual({ amount: '90.00', currency: 'BRL' });

    const debits = harness.fake.ledger.walletEntries.filter(
      (entry) => entry.direction === LedgerDirection.Debit,
    );
    expect(debits).toHaveLength(1);
  });

  it('wallet inexistente é rejeitada com WALLET_NOT_FOUND', async () => {
    const harness = setup();
    const result = await harness.submit.execute(
      command('wallet-inexistente', {
        providerId: 'provider-a',
        externalTransactionId: 'ext-404',
        amount: '10.00',
      }),
    );

    expect(result.status).toBe(WagerTransactionStatus.Rejected);
    expect(result.failureCode).toBe(FailureCode.WalletNotFound);
    expect(result.walletId).toBeNull();
    expect(harness.fake.ledger.walletEntries).toHaveLength(0);
  });

  it('provider-b não opera wallet adotada por provider-a (tenancy)', async () => {
    const harness = setup();
    const walletId = await openWalletWith(harness);

    const owned = await harness.submit.execute(
      command(walletId, {
        providerId: 'provider-a',
        externalTransactionId: 'ext-owner',
        amount: '10.00',
      }),
    );
    expect(owned.status).toBe(WagerTransactionStatus.Processed);
    expect(harness.fake.wallets.get(walletId)?.providerId).toBe('provider-a');

    const foreign = await harness.submit.execute(
      command(walletId, {
        providerId: 'provider-b',
        externalTransactionId: 'ext-foreign',
        amount: '10.00',
      }),
    );
    expect(foreign.status).toBe(WagerTransactionStatus.Rejected);
    expect(foreign.failureCode).toBe(FailureCode.ProviderMismatch);

    // apenas o débito do dono aconteceu
    const debits = harness.fake.ledger.walletEntries.filter(
      (entry) => entry.direction === LedgerDirection.Debit,
    );
    expect(debits).toHaveLength(1);
    expect(harness.fake.wallets.get(walletId)?.providerId).toBe('provider-a');
  });

  it('REFUND sem referência persistida fica PENDING_REFERENCE (sem mover saldo)', async () => {
    const harness = setup();
    const walletId = await openWalletWith(harness);

    const result = await harness.submit.execute(
      command(walletId, {
        providerId: 'provider-a',
        externalTransactionId: 'ext-refund',
        amount: '10.00',
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: 'bet-inexistente',
      }),
    );

    expect(result.status).toBe(WagerTransactionStatus.PendingReference);
    expect(
      harness.fake.ledger.walletEntries.filter(
        (entry) => entry.direction === LedgerDirection.Credit,
      ),
    ).toHaveLength(1); // apenas o OPENING
  });

  it('REFUND + ROLLBACK da mesma BET: o segundo estorno é REVERSAL_ALREADY_APPLIED', async () => {
    const harness = setup();
    const walletId = await openWalletWith(harness);

    const bet = await harness.submit.execute(
      command(walletId, {
        providerId: 'provider-a',
        externalTransactionId: 'bet-1',
        amount: '30.00',
      }),
    );
    expect(bet.status).toBe(WagerTransactionStatus.Processed);

    const refund = await harness.submit.execute(
      command(walletId, {
        providerId: 'provider-a',
        externalTransactionId: 'refund-1',
        amount: '30.00',
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: 'bet-1',
      }),
    );
    expect(refund.status).toBe(WagerTransactionStatus.Processed);

    const rollback = await harness.submit.execute(
      command(walletId, {
        providerId: 'provider-a',
        externalTransactionId: 'rollback-1',
        amount: '30.00',
        kind: WagerTransactionKind.Rollback,
        referenceExternalTransactionId: 'bet-1',
      }),
    );
    expect(rollback.status).toBe(WagerTransactionStatus.Rejected);
    expect(rollback.failureCode).toBe(FailureCode.ReversalAlreadyApplied);

    // OPENING(+100) + REFUND(+30) − BET(30) = 100. O ROLLBACK não creditou.
    expect(harness.fake.wallets.get(walletId)?.balance.toString()).toBe('100.00');
  });

  it('mensagem SQS repetida (mesmo messageId) não reprocessa', async () => {
    const harness = setup();
    const walletId = await openWalletWith(harness);
    const inbox = { messageId: 'msg-1', payloadHash: 'hash-1' };

    const first = await harness.submit.execute(
      command(walletId, {
        providerId: 'provider-a',
        externalTransactionId: 'ext-sqs',
        amount: '10.00',
        channel: 'sqs',
        inbox,
      }),
    );
    const second = await harness.submit.execute(
      command(walletId, {
        providerId: 'provider-a',
        externalTransactionId: 'ext-sqs',
        amount: '10.00',
        channel: 'sqs',
        inbox,
      }),
    );

    expect(first.duplicateMessage).toBe(false);
    expect(second.duplicateMessage).toBe(true);
    expect(second.idempotentReplay).toBe(true);
    expect(
      harness.fake.ledger.walletEntries.filter(
        (entry) => entry.direction === LedgerDirection.Debit,
      ),
    ).toHaveLength(1);
  });
});
