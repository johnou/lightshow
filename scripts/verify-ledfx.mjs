import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { LedFxEngine } from '../ledfx-engine.js';

// Synthetic audio goes only to LedFx's dummy device: no speakers or real lights.
const python = process.env.LIGHTSHOW_LEDFX_PYTHON || fileURLToPath(new URL('../.lightshow-tools/ledfx-venv/bin/python', import.meta.url));
let frames = [];
const errors = [];
const engine = new LedFxEngine({ python, onFrame: frame => frames.push(frame), onError: error => errors.push(error.message) });
try {
  await engine.start({ ids:['hue:test-one', 'hue:test-two'], palette:[[255,0,0], [0,255,0], [0,0,255]] });
  const cases = [['silence',0,0,null], ['bass',80,0.4,0], ['midrange',1000,0.4,1], ['treble',8000,0.4,2], ['silence after music',0,0,null]];
  for (const [label, frequency, amplitude, channel] of cases) {
    frames = [];
    let sample = 0;
    const start = performance.now();
    for (let n=0; n<180; n++) {
      const pcm = Buffer.alloc(1600);
      for (let i=0; i<800; i++) pcm.writeInt16LE(Math.round(Math.sin(2*Math.PI*frequency*sample++/48000)*amplitude*32767), i*2);
      engine.feed(pcm);
      await sleep(Math.max(0, start+(n+1)*1000/60-performance.now()));
    }
    const tail = frames.slice(-30);
    assert.ok(tail.length >= 20, `${label}: missing output frames`);
    const mean = [0,1].map(bulb => [0,1,2].map(c => Math.round(tail.reduce((sum,frame) => sum+frame[bulb][c], 0)/tail.length)));
    for (const rgb of mean) {
      if (channel === null) assert.ok(rgb.every(value => value <= 2), `${label}: expected darkness, got ${rgb}`);
      else {
        assert.ok(rgb[channel] > 20, `${label}: frequency band disappeared: ${rgb}`);
        assert.ok(rgb.every((value,c) => c === channel || value < rgb[channel]/4), `${label}: wrong frequency color: ${rgb}`);
      }
    }
    console.log(`${label}: ${JSON.stringify(mean)}`);
  }
  assert.deepEqual(errors, []);
  console.log('LedFx PCM → frequency analysis → two-bulb output passed.', engine.stats);
} finally {
  await engine.stop();
}
assert.equal(engine.child, null);
assert.equal(engine.configDir, null);
assert.equal(engine.timer, null);
