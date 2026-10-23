/**
 * Executa `worker` sobre `items` com concorrência limitada, preservando o
 * paralelismo necessário sem saturar o pool de conexões.
 * Erros do worker não interrompem os demais (o chamador decide o que fazer).
 */
export async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const concurrency = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;

  const runners = Array.from({ length: concurrency }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      await worker(items[index], index);
    }
  });

  await Promise.all(runners);
}
