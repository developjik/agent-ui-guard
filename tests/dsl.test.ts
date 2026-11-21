import { describe, expect, it } from 'vitest';
import {
  always,
  eventually,
  normalizeCheckResult,
} from '../src/invariants.js';
import type { InvariantContext } from '../src/types.js';
import { makeLedger } from './helpers.js';

const context = { ledger: makeLedger(), step: 3, trace: [] } as unknown as InvariantContext;

describe('always()', () => {
  it('builds an always invariant with the given name and description', () => {
    const invariant = always('no toast overflow', () => true, {
      description: 'toasts never cover the composer',
    });
    expect(invariant.kind).toBe('always');
    expect(invariant.name).toBe('no toast overflow');
    expect(invariant.description).toBe('toasts never cover the composer');
    expect(invariant.timeoutMs).toBeUndefined();
  });

  it('passes through the check function result', async () => {
    const result = await always('x', () => false).check(context);
    expect(normalizeCheckResult(result).ok).toBe(false);
  });
});

describe('eventually()', () => {
  it('defaults to a 5s deadline', () => {
    const invariant = eventually('answer arrives', () => true);
    expect(invariant.kind).toBe('eventually');
    expect(invariant.timeoutMs).toBe(5_000);
  });

  it('within() returns a new invariant with the custom deadline', () => {
    const base = eventually('answer arrives', () => true);
    const tightened = base.within(250);
    expect(tightened.timeoutMs).toBe(250);
    expect(base.timeoutMs).toBe(5_000);
    expect(tightened.name).toBe('answer arrives');
    expect(tightened.kind).toBe('eventually');
  });
});

describe('normalizeCheckResult', () => {
  it('treats undefined and true as passing', () => {
    expect(normalizeCheckResult(undefined)).toEqual({ ok: true });
    expect(normalizeCheckResult(true)).toEqual({ ok: true });
  });

  it('treats false as failing without a message', () => {
    expect(normalizeCheckResult(false)).toEqual({ ok: false });
  });

  it('carries message and evidence from object results', () => {
    expect(
      normalizeCheckResult({ ok: false, message: 'boom', evidence: { n: 2 } }),
    ).toEqual({ ok: false, message: 'boom', evidence: { n: 2 } });
  });

  it('drops the message of a passing object result', () => {
    expect(normalizeCheckResult({ ok: true, message: 'fine' })).toEqual({
      ok: true,
      message: 'fine',
    });
  });
});
