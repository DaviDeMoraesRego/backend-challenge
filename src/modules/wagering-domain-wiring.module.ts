import { Module, type DynamicModule } from '@nestjs/common';
import {
  CLOCK,
  CONFIG,
  GET_TRANSACTION,
  GET_TRANSACTION_BY_EXTERNAL_ID,
  GET_WALLET,
  ID_GENERATOR,
  LIST_WALLET_LEDGER,
  LOGGER,
  METRICS,
  OPEN_WALLET,
  OPPORTUNISTIC_SETTLEMENT_TRIGGER,
  PROVIDER_DIRECTORY,
  RECONCILE_WALLET,
  SETTLE_WAGER_TRANSACTION,
  SUBMIT_WAGER_TRANSACTION,
  SUPPORTED_CURRENCIES,
  TRACER,
  TX_RUNNER,
} from '../config/tokens';
import type { AppConfig } from '../config/env';
import type { SupportedCurrencies } from '../contexts/wagering/domain/money/currency';
import type {
  Clock,
  IdGenerator,
  LoggerPort,
  MetricsPort,
  ProviderDirectory,
  Tracer,
} from '../contexts/wagering/application/ports/misc-ports';
import type { TransactionRunner } from '../contexts/wagering/application/ports/unit-of-work';
import { OpportunisticSettlementTrigger } from '../contexts/wagering/infrastructure/workers/opportunistic-settlement-trigger';
import { OpenWallet } from '../contexts/wagering/application/use-cases/open-wallet';
import {
  GetTransaction,
  GetTransactionByExternalId,
  GetWallet,
  ListWalletLedger,
} from '../contexts/wagering/application/use-cases/queries';
import { ReconcileWallet } from '../contexts/wagering/application/use-cases/reconcile-wallet';
import { SettleWagerTransaction } from '../contexts/wagering/application/use-cases/settle-wager-transaction';
import { SubmitWagerTransaction } from '../contexts/wagering/application/use-cases/submit-wager-transaction';

const USE_CASES = [
  OPEN_WALLET,
  SUBMIT_WAGER_TRANSACTION,
  SETTLE_WAGER_TRANSACTION,
  GET_WALLET,
  LIST_WALLET_LEDGER,
  GET_TRANSACTION,
  GET_TRANSACTION_BY_EXTERNAL_ID,
  RECONCILE_WALLET,
  OPPORTUNISTIC_SETTLEMENT_TRIGGER,
];

/** Moeda default = primeira da allow-list (`SUPPORTED_CURRENCIES`), nunca implícita. */
const defaultCurrencyOf = (config: AppConfig): string =>
  config.env.SUPPORTED_CURRENCIES.split(',')[0]?.trim() ?? 'BRL';

/**
 * Use cases são classes TS puras: registradas por `useFactory` (sem `@Injectable()`).
 * Como Bun não emite `design:paramtypes`, os parâmetros das factories são tipados
 * explicitamente — a ordem em `inject` é o único contrato e o compilador a valida.
 */
@Module({})
export class WageringDomainWiringModule {
  static forRoot(): DynamicModule {
    return {
      module: WageringDomainWiringModule,
      global: true,
      providers: [
        {
          provide: OPEN_WALLET,
          useFactory: (
            runner: TransactionRunner,
            clock: Clock,
            ids: IdGenerator,
            currencies: SupportedCurrencies,
            tracer: Tracer,
            config: AppConfig,
          ) =>
            new OpenWallet(
              runner,
              clock,
              ids,
              currencies,
              tracer,
              defaultCurrencyOf(config),
            ),
          inject: [TX_RUNNER, CLOCK, ID_GENERATOR, SUPPORTED_CURRENCIES, TRACER, CONFIG],
        },
        {
          provide: SUBMIT_WAGER_TRANSACTION,
          useFactory: (
            runner: TransactionRunner,
            clock: Clock,
            ids: IdGenerator,
            providers: ProviderDirectory,
            currencies: SupportedCurrencies,
            tracer: Tracer,
            metrics: MetricsPort,
            logger: LoggerPort,
          ) =>
            new SubmitWagerTransaction(
              runner,
              clock,
              ids,
              providers,
              currencies,
              tracer,
              metrics,
              logger,
            ),
          inject: [
            TX_RUNNER,
            CLOCK,
            ID_GENERATOR,
            PROVIDER_DIRECTORY,
            SUPPORTED_CURRENCIES,
            TRACER,
            METRICS,
            LOGGER,
          ],
        },
        {
          provide: SETTLE_WAGER_TRANSACTION,
          useFactory: (
            runner: TransactionRunner,
            clock: Clock,
            ids: IdGenerator,
            tracer: Tracer,
            metrics: MetricsPort,
            logger: LoggerPort,
            config: AppConfig,
          ) =>
            new SettleWagerTransaction(runner, clock, ids, tracer, metrics, logger, {
              maxAttempts: config.env.PENDING_MAX_ATTEMPTS,
              ttlHours: config.env.PENDING_TTL_HOURS,
            }),
          inject: [TX_RUNNER, CLOCK, ID_GENERATOR, TRACER, METRICS, LOGGER, CONFIG],
        },
        {
          provide: GET_WALLET,
          useFactory: (runner: TransactionRunner) => new GetWallet(runner),
          inject: [TX_RUNNER],
        },
        {
          provide: LIST_WALLET_LEDGER,
          useFactory: (runner: TransactionRunner) => new ListWalletLedger(runner),
          inject: [TX_RUNNER],
        },
        {
          provide: GET_TRANSACTION,
          useFactory: (runner: TransactionRunner) => new GetTransaction(runner),
          inject: [TX_RUNNER],
        },
        {
          provide: GET_TRANSACTION_BY_EXTERNAL_ID,
          useFactory: (runner: TransactionRunner) =>
            new GetTransactionByExternalId(runner),
          inject: [TX_RUNNER],
        },
        {
          provide: RECONCILE_WALLET,
          useFactory: (runner: TransactionRunner, metrics: MetricsPort, logger: LoggerPort) =>
            new ReconcileWallet(runner, metrics, logger),
          inject: [TX_RUNNER, METRICS, LOGGER],
        },
        {
          provide: OPPORTUNISTIC_SETTLEMENT_TRIGGER,
          useFactory: (
            runner: TransactionRunner,
            settle: SettleWagerTransaction,
            logger: LoggerPort,
          ) => new OpportunisticSettlementTrigger(runner, settle, logger),
          inject: [TX_RUNNER, SETTLE_WAGER_TRANSACTION, LOGGER],
        },
      ],
      exports: USE_CASES,
    };
  }
}
