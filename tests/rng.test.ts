import { describe, expect, it } from 'vitest';
import { createRng } from '../src/rng.js';

describe('createRng', () => {
  it('is deterministic for a seed', () => {
    const a = createRng(1337);
    const b = createRng(1337);
    const first = Array.from({ length: 20 }, () => a.next());
    const second = Array.from({ length: 20 }, () => b.next());
    expect(first).toEqual(second);
  });

  it('produces different sequences for different seeds', () => {
    const a = Array.from({ length: 10 }, (_, i) => createRng(1).next() + i * 0);
    const b = Array.from({ length: 10 }, (_, i) => createRng(2).next() + i * 0);
    expect(a).not.toEqual(b);
  });

  it('keeps next() inside [0, 1)', () => {
    const rng = createRng(42);
    for (let i = 0; i < 500; i += 1) {
      const value = rng.next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('int() covers the requested range', () => {
    const rng = createRng(7);
    const seen = new Set<number>();
    for (let i = 0; i < 200; i += 1) {
      const value = rng.int(4);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(3);
      seen.add(value);
    }
    expect(seen.size).toBe(4);
  });

  it('int() rejects an empty range', () => {
    const rng = createRng(7);
    expect(() => rng.int(0)).toThrow(RangeError);
  });

  it('weighted() honours weights', () => {
    const rng = createRng(99);
    const items = [
      { name: 'rare', weight: 1 },
      { name: 'common', weight: 19 },
    ];
    let common = 0;
    for (let i = 0; i < 2_000; i += 1) {
      if (rng.weighted(items, (item) => item.weight).name === 'common') common += 1;
    }
    expect(common).toBeGreaterThan(1_700);
    expect(common).toBeLessThan(1_980);
  });

  it('weighted() ignores non-positive weights and falls back to a uniform pick', () => {
    const rng = createRng(5);
    const items = [{ weight: 0 }, { weight: -2 }];
    const picked = rng.weighted(items, (item) => item.weight);
    expect(items).toContain(picked);
  });

  it('pick() rejects an empty array', () => {
    const rng = createRng(5);
    expect(() => rng.pick([])).toThrow(RangeError);
  });
});
