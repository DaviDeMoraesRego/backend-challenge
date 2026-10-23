/** Registros planos (1:1 com o schema). NUMERIC/BIGINT chegam como string do driver pg. */
export interface WalletRow {
  readonly id: string;
  readonly player_id: string;
  readonly provider_id: string | null;
  readonly currency: string;
  readonly balance: string;
  readonly version: string;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface WagerTransactionRow {
  readonly id: string;
  readonly provider_id: string;
  readonly external_transaction_id: string;
  readonly idempotency_key: string;
  readonly payload_hash: string;
  readonly wallet_id: string | null;
  readonly player_id: string;
  readonly currency: string;
  readonly round_id: string;
  readonly game_id: string;
  readonly kind: string;
  readonly amount: string;
  readonly status: string;
  readonly reference_external_transaction_id: string | null;
  readonly reference_transaction_id: string | null;
  readonly failure_code: string | null;
  readonly resulting_balance_amount: string | null;
  readonly processed_at: Date | null;
  readonly attempts: number;
  readonly next_attempt_at: Date | null;
  readonly created_at: Date;
}

export interface LedgerEntryRow {
  readonly id: string;
  readonly journal_id: string;
  readonly transaction_id: string;
  readonly wallet_id: string | null;
  readonly account_id: string | null;
  readonly direction: string;
  readonly amount: string;
  readonly currency: string;
  readonly balance_before: string | null;
  readonly balance_after: string | null;
  readonly wallet_version: string | null;
  readonly created_at: Date;
}

export interface OutboxRow {
  readonly id: string;
  readonly aggregate_id: string;
  readonly event_type: string;
  readonly payload: Record<string, unknown>;
  readonly trace_context: { traceparent?: string; tracestate?: string } | null;
  readonly occurred_at: Date;
  readonly attempts: number;
  readonly next_attempt_at: Date;
  readonly published_at: Date | null;
  readonly created_at: Date;
}

export interface InboxRow {
  readonly consumer_name: string;
  readonly message_id: string;
  readonly payload_hash: string;
  readonly received_at: Date;
  readonly processed_at: Date | null;
}

export interface PendingClaimRow {
  readonly id: string;
  readonly attempts: number;
  readonly created_at: Date;
}

export interface LedgerAggregateRow {
  readonly wallet_id: string;
  readonly sum: string;
  readonly entries: number;
  readonly currency: string | null;
  readonly last_balance_after: string | null;
  readonly last_wallet_version: string | null;
}
