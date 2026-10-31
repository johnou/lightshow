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
test('keeps independent smoothed bass, mid and high signals', () => {
  const energy=new MusicEnergy();
  for (let time=0; time<1000; time+=25) energy.feed(0.4,time,{bass:0.8,mid:0.1,high:0.3});
  const bands=energy.snapshot().bands;
  assert.ok(bands[0]>bands[2] && bands[2]>bands[1]);
});
