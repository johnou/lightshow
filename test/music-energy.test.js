import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MusicEnergy } from '../music-energy.js';

test('tracks sustained changes in loudness without reacting to a single spike', () => {
  const energy = new MusicEnergy();
  for (let time=0; time<12000; time+=25) energy.feed(0.3,time);
  assert.equal(energy.snapshot().state,'steady');
  energy.feed(1,12000);
  assert.equal(energy.snapshot().state,'steady');
  for (let time=12025; time<15000; time+=25) energy.feed(0.9,time);
  assert.equal(energy.snapshot().state,'intense');
  for (let time=15000; time<21000; time+=25) energy.feed(0.02,time);
  assert.equal(energy.snapshot().state,'quiet');
  assert.ok(energy.snapshot().level < 0.03);
});
