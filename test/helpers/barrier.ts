/**
 * Barreira de disparo paralelo real: N closures preparam o trabalho, bloqueiam e
 * disparam juntas no mesmo tick (plans/07 §2).
 */
export class Barrier {
  private arrived = 0;
  private released = false;
  private resolveRelease: (() => void) | null = null;
  private readonly releasePromise: Promise<void>;

  constructor(private readonly parties: number) {
    this.releasePromise = new Promise((resolve) => {
      this.resolveRelease = resolve;
    });
  }

  async arriveAndWait(): Promise<void> {
    this.arrived += 1;
    if (this.arrived >= this.parties && !this.released) {
      this.released = true;
      this.resolveRelease?.();
    }
    await this.releasePromise;
  }
}

export async function runInParallel<T>(
  count: number,
  work: (index: number) => Promise<T>,
): Promise<Array<PromiseSettledResult<T>>> {
  const barrier = new Barrier(count);
  const tasks = Array.from({ length: count }, (_, index) =>
    (async () => {
      await barrier.arriveAndWait();
      return work(index);
    })(),
  );
  return Promise.allSettled(tasks);
}
