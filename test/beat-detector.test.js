import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BeatDetector } from '../beat-detector.js';
test('detects peaks while limiting repeated beats', () => {
  let beats=0; const detector=new BeatDetector(()=>beats++);
  detector.feed(0.01,1000); detector.feed(0.5,1100); detector.feed(0.8,1200);
  assert.equal(beats,1);
  for (let i=0;i<40;i++) detector.feed(0.01,1300+i*20);
  detector.feed(0.8,2200); assert.equal(beats,2);
});
