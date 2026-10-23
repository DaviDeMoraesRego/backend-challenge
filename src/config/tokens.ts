/**
 * Injecção de dependência 100% explícita por tokens (ADR-13):
 * Bun não emite `design:paramtypes`, logo nenhum provider pode depender de metadata refletida.
 */
export const CONFIG = Symbol('CONFIG');
export const ORM = Symbol('ORM');
export const TX_RUNNER = Symbol('TX_RUNNER');
export const CLOCK = Symbol('CLOCK');
export const ID_GENERATOR = Symbol('ID_GENERATOR');
export const TRACER = Symbol('TRACER');
export const LOGGER = Symbol('LOGGER');
export const METRICS = Symbol('METRICS');
export const PROVIDER_DIRECTORY = Symbol('PROVIDER_DIRECTORY');
export const SUPPORTED_CURRENCIES = Symbol('SUPPORTED_CURRENCIES');
export const PROVIDER_IDENTITY = Symbol('PROVIDER_IDENTITY');
export const SQS_CLIENT = Symbol('SQS_CLIENT');
export const EVENT_PUBLISHER = Symbol('EVENT_PUBLISHER');

// use cases
export const OPEN_WALLET = Symbol('OPEN_WALLET');
export const SUBMIT_WAGER_TRANSACTION = Symbol('SUBMIT_WAGER_TRANSACTION');
export const SETTLE_WAGER_TRANSACTION = Symbol('SETTLE_WAGER_TRANSACTION');
export const GET_WALLET = Symbol('GET_WALLET');
export const LIST_WALLET_LEDGER = Symbol('LIST_WALLET_LEDGER');
export const GET_TRANSACTION = Symbol('GET_TRANSACTION');
export const GET_TRANSACTION_BY_EXTERNAL_ID = Symbol('GET_TRANSACTION_BY_EXTERNAL_ID');
export const RECONCILE_WALLET = Symbol('RECONCILE_WALLET');

// workers / runtime
export const SQS_POLLER = Symbol('SQS_POLLER');
export const OUTBOX_PUBLISHER = Symbol('OUTBOX_PUBLISHER');
export const PENDING_REFERENCE_WORKER = Symbol('PENDING_REFERENCE_WORKER');
export const RECONCILIATION_JOB = Symbol('RECONCILIATION_JOB');
export const RETENTION_JOB = Symbol('RETENTION_JOB');
export const READINESS_PROBE = Symbol('READINESS_PROBE');
export const OPPORTUNISTIC_SETTLEMENT_TRIGGER = Symbol('OPPORTUNISTIC_SETTLEMENT_TRIGGER');
