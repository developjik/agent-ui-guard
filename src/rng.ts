/**
 * Deterministic pseudo-random numbers.
 *
 * The same seed always produces the same action sequence, which is what makes a
 * fuzz failure reproducible from `trace.json` alone.
 */

export interface Rng {
  /** The seed this generator started from. */
  readonly seed: number;
  /** Next float in [0, 1). */
  next(): number;
  /** Next integer in [0, maxExclusive). */
  int(maxExclusive: number): number;
  /** `true` with the given probability (default 0.5). */
  bool(probability?: number): boolean;
  /** A uniformly picked element. */
  pick<T>(items: readonly T[]): T;
  /** A picked element, biased by `weightOf` (non-positive weights are skipped). */
  weighted<T>(items: readonly T[], weightOf: (item: T) => number): T;
}

/** mulberry32: 32-bit state, good enough for fuzzing and tiny to embed. */
export function createRng(seed: number): Rng {
  let state = seed >>> 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const rng: Rng = {
    seed: seed >>> 0,
    next,
    int(maxExclusive: number): number {
      if (!Number.isFinite(maxExclusive) || maxExclusive <= 0) {
        throw new RangeError(`int(maxExclusive) needs a positive number, got ${maxExclusive}`);
      }
      return Math.floor(next() * maxExclusive);
    },
    bool(probability = 0.5): boolean {
      return next() < probability;
    },
    pick<T>(items: readonly T[]): T {
      if (items.length === 0) throw new RangeError('pick() needs a non-empty array');
      return items[rng.int(items.length)]!;
    },
    weighted<T>(items: readonly T[], weightOf: (item: T) => number): T {
      if (items.length === 0) throw new RangeError('weighted() needs a non-empty array');
      const weights = items.map((item) => {
        const weight = weightOf(item);
        return Number.isFinite(weight) && weight > 0 ? weight : 0;
      });
      const total = weights.reduce((sum, weight) => sum + weight, 0);
      if (total <= 0) return rng.pick(items);
      let roll = next() * total;
      for (let i = 0; i < items.length; i += 1) {
        roll -= weights[i]!;
        if (roll < 0) return items[i]!;
      }
      return items[items.length - 1]!;
    },
  };

  return rng;
}
