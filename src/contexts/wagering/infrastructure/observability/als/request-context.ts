import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContextStore {
  correlationId: string;
  traceId?: string;
  spanId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
}

const storage = new AsyncLocalStorage<RequestContextStore>();

/**
 * Contexto de request/mensagem via AsyncLocalStorage (nunca providers request-scoped —
 * plans/06 §4.3). Funciona igual em HTTP e no handler SQS.
 */
export const requestContext = {
  run<T>(store: RequestContextStore, fn: () => T): T {
    return storage.run(store, fn);
  },
  get(): RequestContextStore | undefined {
    return storage.getStore();
  },
  patch(values: Partial<RequestContextStore>): void {
    const store = storage.getStore();
    if (!store) return;
    Object.assign(store, values);
  },
  correlationId(fallback: string): string {
    return storage.getStore()?.correlationId ?? fallback;
  },
};
