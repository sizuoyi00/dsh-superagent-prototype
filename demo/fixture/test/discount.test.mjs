import assert from 'node:assert/strict';
import test from 'node:test';

import { applyDiscount } from '../src/discount.mjs';

test('applies a percentage discount and rounds to two decimal places', () => {
  assert.equal(applyDiscount(19.99, 15), 16.99);
});

test('accepts a zero percent discount', () => {
  assert.equal(applyDiscount(42.25, 0), 42.25);
});

test('rejects negative amounts', () => {
  assert.throws(() => applyDiscount(-1, 10), /amount/i);
});

test('rejects discount percentages outside the supported range', () => {
  assert.throws(() => applyDiscount(10, -1), /discount/i);
  assert.throws(() => applyDiscount(10, 101), /discount/i);
});
