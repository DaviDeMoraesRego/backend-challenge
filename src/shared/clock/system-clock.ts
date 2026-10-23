export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/** Relógio de teste — determinístico, sem IO. */
export function fixedClock(start: Date): Clock & { advance(ms: number): void; set(date: Date): void } {
  let current = new Date(start.getTime());
  return {
    now: () => new Date(current.getTime()),
    advance: (ms: number) => {
      current = new Date(current.getTime() + ms);
    },
    set: (date: Date) => {
      current = new Date(date.getTime());
    },
  };
}
