/**
 * Polling com deadline — proibido `sleep` fixo como forma de espera (plans/07 §2).
 */
export interface EventuallyOptions {
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  readonly message?: string;
}

export async function eventually<T>(
  probe: () => Promise<T> | T,
  options: EventuallyOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const intervalMs = options.intervalMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  for (;;) {
    try {
      return await probe();
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) {
      const detail = lastError instanceof Error ? lastError.message : String(lastError);
      throw new Error(
        `eventually: condição não satisfeita em ${timeoutMs}ms${options.message ? ` (${options.message})` : ''} — última falha: ${detail}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
