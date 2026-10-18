import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRng } from '../lib/rng.js';

test('same seed gives the same sequence', () => {
  const a = makeRng(42), b = makeRng(42);
  assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
});

test('values are in [0, 1)', () => {
  const r = makeRng(7);
  for (let i = 0; i < 1000; i++) { const v = r(); assert.ok(v >= 0 && v < 1); }
});

test('different seeds differ', () => {
  assert.notEqual(makeRng(1)(), makeRng(2)());
});
