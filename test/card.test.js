import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardSvg, cardPng, W, H } from '../src/card.mjs';
import { allCrossings, getCrossing } from '../src/registry.js';

test('every crossing gets a card whose text stays inside the picture', () => {
  // Crude but honest: the widest line at its size must fit the width.
  const perChar = { 800: 0.46, 500: 0.42 };
  for (const c of allCrossings()) {
    const svg = cardSvg(c);
    for (const m of svg.matchAll(/font-weight="(\d+)" font-size="(\d+)"[^>]*>([^<]*(?:<tspan[^>]*>[^<]*<\/tspan>)?[^<]*)<\/text>/g)) {
      const text = m[3].replace(/<[^>]+>/g, '').replace(/&amp;|&lt;|&gt;|&quot;/g, 'x');
      const width = Number(m[2]) * perChar[m[1]] * text.length;
      assert.ok(width <= W - 100, `${c.id}: "${text}" at ${m[2]}px is ~${Math.round(width)}px wide`);
    }
  }
});

test('cards render as PNGs, once', () => {
  const a = cardPng(getCrossing('liss'));
  assert.equal(a.subarray(1, 4).toString(), 'PNG');
  assert.equal(cardPng(getCrossing('liss')), a);
  assert.ok(cardPng(null).length > 10_000);
  assert.ok(W === 1200 && H === 630);
});
