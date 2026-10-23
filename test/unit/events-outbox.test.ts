import { describe, expect, it } from 'bun:test';
import { IntegrationEvent } from '../../src/contexts/wagering/domain/events/integration-event';
import { WalletBalanceChanged } from '../../src/contexts/wagering/domain/events/wallet-balance-changed';
import { WagerTransactionProcessed } from '../../src/contexts/wagering/domain/events/wager-transaction-processed';
import { Journal } from '../../src/contexts/wagering/domain/ledger/journal';
import { openingEquityAccount } from '../../src/contexts/wagering/domain/ledger/account-ref';
import { LedgerDirection } from '../../src/contexts/wagering/domain/ledger/ledger-direction';
import { WalletLedgerEntry } from '../../src/contexts/wagering/domain/ledger/wallet-ledger-entry';
import { Money } from '../../src/contexts/wagering/domain/money/money';
import { OutboxMessage } from '../../src/contexts/wagering/domain/outbox/outbox-message';
import { InboxMessage } from '../../src/contexts/wagering/domain/inbox/inbox-message';
import { WagerTransactionKind } from '../../src/contexts/wagering/domain/transaction/wager-transaction-kind';
import { NOW, WALLET_ID, makeTransaction, makeWallet } from '../helpers/domain-factories';

const ctx = {
  eventId: '0192f298-345e-7e38-af88-e43f851a819d',
  correlationId: 'corr-12345678',
  causationId: 'msg-1',
  occurredAt: NOW,
};

describe('Eventos e Outbox/Inbox (UT-48…UT-50)', () => {
  it('UT-48 envelope toJSON é estável; version/eventType no tipo; payload usa MoneyProps', () => {
    const tx = makeTransaction({ kind: WagerTransactionKind.Bet, amount: '25.00' });
    tx.markProcessed(undefined, NOW, Money.of('75.00', 'BRL'));
    const event = WagerTransactionProcessed.from(tx, { ...ctx, walletVersion: 2 });
    const envelope = event.toJSON();

    expect(event).toBeInstanceOf(IntegrationEvent);
    expect(envelope.eventType).toBe('WagerTransactionProcessed');
    expect(envelope.version).toBe(1);
    expect(envelope.occurredAt).toBe(NOW.toISOString());
    expect(envelope.aggregateId).toBe(tx.id);
    expect(envelope.correlationId).toBe(ctx.correlationId);
    expect(envelope.data.money).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(envelope.data.resultingBalance).toEqual({ amount: '75.00', currency: 'BRL' });
    // JSON estável: nada de instâncias de Money
    expect(JSON.parse(JSON.stringify(envelope)).data.money.amount).toBe('25.00');
  });

  it('UT-49 WalletBalanceChanged.from carrega as duas pontas do saldo', () => {
    const wallet = makeWallet({ balance: '75.00', version: 2 });
    const journal = Journal.create({
      id: 'j1',
      transactionId: 'tx-1',
      createdAt: NOW,
      walletLeg: {
        walletId: WALLET_ID,
        direction: LedgerDirection.Debit,
        amount: Money.of('25.00', 'BRL'),
        balanceBefore: Money.of('100.00', 'BRL'),
        balanceAfter: Money.of('75.00', 'BRL'),
        walletVersion: 2,
      },
      counterpartyLeg: {
        account: openingEquityAccount('BRL'),
        direction: LedgerDirection.Credit,
        amount: Money.of('25.00', 'BRL'),
      },
    });
    const entry = WalletLedgerEntry.create({
      id: 'leg-1',
      journalId: journal.id,
      walletId: WALLET_ID,
      transactionId: 'tx-1',
      direction: LedgerDirection.Debit,
      money: Money.of('25.00', 'BRL'),
      balanceBefore: Money.of('100.00', 'BRL'),
      balanceAfter: Money.of('75.00', 'BRL'),
      walletVersion: 2,
      createdAt: NOW,
    });
    const event = WalletBalanceChanged.from(wallet, entry, ctx);
    expect(event.aggregateId).toBe(WALLET_ID);
    expect(event.toJSON().data).toEqual({
      walletId: WALLET_ID,
      transactionId: 'tx-1',
      direction: LedgerDirection.Debit,
      money: { amount: '25.00', currency: 'BRL' },
      balanceBefore: { amount: '100.00', currency: 'BRL' },
      balanceAfter: { amount: '75.00', currency: 'BRL' },
      walletVersion: 2,
    });
    // LOSS não gera WalletBalanceChanged: o evento só nasce com perna de ledger.
    expect(event.data.balanceBefore.amount).not.toBe(event.data.balanceAfter.amount);
  });

  it('UT-50 OutboxMessage: backoff crescente com jitter, isDue e poison; InboxMessage markProcessed', () => {
    const tx = makeTransaction();
    tx.markProcessed(undefined, NOW, Money.of('75.00', 'BRL'));
    const event = WagerTransactionProcessed.from(tx, { ...ctx });

    const message = OutboxMessage.enqueue(event, {
      id: 'outbox-1',
      now: NOW,
      traceContext: { traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' },
    });
    expect(message.isPending()).toBe(true);
    expect(message.isDue(NOW)).toBe(true);
    expect(message.traceContext?.traceparent).toContain('4bf92f3577b34da6a3ce929d0e0e4736');

    message.scheduleRetry(NOW, { maxAttempts: 5, jitterMs: 0 });
    const firstDelay = message.nextAttemptAt.getTime() - NOW.getTime();
    expect(firstDelay).toBeGreaterThanOrEqual(2_000);
    message.scheduleRetry(NOW, { maxAttempts: 5, jitterMs: 0 });
    const secondDelay = message.nextAttemptAt.getTime() - NOW.getTime();
    expect(secondDelay).toBeGreaterThan(firstDelay);

    const poisonAt = new Date(NOW.getTime() + 1000);
    for (let i = 0; i < 10; i += 1) {
      message.scheduleRetry(poisonAt, { maxAttempts: 3, jitterMs: 0 });
    }
    expect(message.isPoisoned(3)).toBe(true);
    expect(message.nextAttemptAt.getTime()).toBeGreaterThan(
      poisonAt.getTime() + 60 * 60 * 1000,
    );

    message.markPublished(NOW);
    expect(message.isPending()).toBe(false);
    expect(message.isDue(NOW)).toBe(false);

    const inbox = InboxMessage.receive({
      messageId: 'msg-1',
      consumerName: 'wager-transactions',
      payloadHash: 'hash',
      receivedAt: NOW,
    });
    expect(inbox.isProcessed()).toBe(false);
    inbox.markProcessed(NOW);
    expect(inbox.isProcessed()).toBe(true);
    expect(inbox.processedAt).toEqual(NOW);
  });
});
