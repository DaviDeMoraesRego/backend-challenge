import { describe, expect, it } from 'bun:test';
import { mapWithConcurrency } from '../../src/shared/async/map-with-concurrency';

const tick = (ms = 2): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe('mapWithConcurrency', () => {
  it('nunca excede o limite informado e processa todos os itens', async () => {
    let active = 0;
    let peak = 0;
    const processed: number[] = [];

    await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3, async (item) => {
      active += 1;
      peak = Math.max(peak, active);
      await tick();
      processed.push(item);
      active -= 1;
    });

    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1); // paralelismo real, não serial
    expect(processed).toHaveLength(10);
  });

  it('lista vazia não executa o worker', async () => {
    let calls = 0;
    await mapWithConcurrency([], 4, async () => {
      calls += 1;
    });
    expect(calls).toBe(0);
  });

  it('normaliza limite inválido para 1', async () => {
    let active = 0;
    let peak = 0;
    await mapWithConcurrency(['a', 'b', 'c'], 0, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await tick();
      active -= 1;
    });
    expect(peak).toBe(1);
  });
});
